require! cli
require! './gorilla'
require! util
require! fs
require! path
require! child_process

async err, which-gjs-stdout, which-gjs-stderr <- child_process.exec "which gjs"

let has-gjs = not err? and which-gjs-stdout.length and not which-gjs-stderr.length

cli.enable 'version'

cli.set-app "gorilla", gorilla.version

cli.set-usage "gorilla [OPTIONS] path/to/script.gs"

let parse-options =
  ast:          ["a", "Display JavaScript AST nodes instead of compilation"]
  bare:         ["b", "Compile without safety top-level closure wrapper"]
  compile:      ["c", "Compile to JavaScript and save as .js files"]
  output:       ["o", "Set the file/directory for compiled JavaScript", "path"]
  interactive:  ["i", "Run interactively with the REPL"]
  nodes:        ["n", "Display GorillaScript parser nodes instead of compilation"]
  stdout:       ["p", "Print the compiled JavaScript to stdout"]
  stdin:        ["s", "Listen for and compile GorillaScript from stdin"]
  eval:         ["e", "Compile and run a string from command line", "string"]
  uglify:       ["u", "Uglify compiled code with UglifyJS2"]
  minify:       [false, "Minimize the use of unnecessary whitespace"]
  sourcemap:    ["m", "Build a SourceMap", "file"]
  join:         ["j", "Join all the generated JavaScript into a single file"]
  "no-prelude": [false, "Do not include the standard prelude"]
  //js:           [false, "Compile to JavaScript (default)"]
  watch:        ["w", "Watch for changes and compile as-needed"]
  embedded:     [false, "Compile as embedded GorillaScript"]
  "embedded-generator": [false, "Compile as a generator-based embedded GorillaScript"]

if has-gjs
  parse-options <<<
    gjs:        [false, "Run with gjs"]

cli.parse parse-options

cli.main #(filenames, options)! -> promise!
  try
    let lang = "js"

    let opts = {}
    if options.uglify
      opts.undefined-name := \undefined
      opts.uglify := true
    if options.minify
      opts.minify := true
    if options.bare
      opts.bare := true
  
    if options["no-prelude"]
      opts.no-prelude := true
    else
      yield gorilla.init { lang }

    if options.stdout
      opts.writer := #(text) -> process.stdout.write text
    
    let handle-code = promise! #(code)*
      let result = if options.ast
        let ast = yield gorilla.ast code, opts
        util.inspect ast.node, false, null
      else if options.nodes
        let nodes = yield gorilla.parse code, opts
        util.inspect nodes.result, false, null
      else if options.stdout
        let compiled = yield gorilla.compile code, opts
        if opts.uglify
          process.stdout.write "\n"
        compiled.code
      else if options.gjs
        let compiled = yield gorilla.compile code, { +\eval } <<< opts
        console.log "running with gjs"
        let gjs = child_process.spawn "gjs"
        gjs.stdout.on 'data', #(data) -> process.stdout.write data
        gjs.stderr.on 'data', #(data) -> process.stderr.write data
        gjs.stdin.write compiled.code
        yield delay! 50_ms
        gjs.stdin.end()
        ""
      else
        let evaled = yield gorilla.eval code, opts
        util.inspect evaled, false, null
      if result != ""
        process.stdout.write result
        process.stdout.write "\n"

    if options.ast and options.compile
      console.error "Cannot specify both --ast and --compile"
    else if options.ast and options.nodes
      console.error "Cannot specify both --ast and --nodes"
    else if options.nodes and options.compile
      console.error "Cannot specify both --nodes and --compile"
    else if options.output and not options.compile
      console.error "Must specify --compile if specifying --output"
    else if options.sourcemap and not options.output
      console.error "Must specify --output if specifying --sourcemap"
    else if filenames.length > 1 and options.sourcemap and not options.join
      console.error "Cannot specify --sourcemap with multiple files unless using --join"
    else if options.eval?
      yield handle-code String(options.eval)
    else if options.interactive and options.stdin
      console.error "Cannot specify --interactive and --stdin"
    else if options.interactive and filenames.length
      console.error "Cannot specify --interactive and filenames"
    else if options.stdin
      cli.with-stdin #(code, callback)!
        (from-promise! handle-code(code))(callback)
    else if options.watch and not filenames.length
      console.error "Cannot specify --watch without filenames"
    else if options.watch and not options.compile
      console.error "Must specify --compile if specifying --watch"
    else if options.watch and options.join
      console.error "TODO: Cannot specify --watch and --join"
    else if options.watch and options.sourcemap
      console.error "TODO: Cannot specify --watch and --sourcemap"
    else if filenames.length
      let sourcemap = if options.sourcemap then require("./sourcemap")(options.output, ".")
      opts.sourcemap := sourcemap
  
      if options["embedded-generator"]
        opts.embedded-generator := true
        options.embedded := true
      if options.embedded
        opts.embedded := true
        opts.noindent := true
  
      let input-p = {}
      for filename in filenames
        input-p[filename] := to-promise! fs.read-file filename, "utf8"
    
      let input = yield every-promise! input-p
    
      let compiled = {}
      let handle-single = promise! #(filename, code)*
        opts.filename := filename
        if options.compile
          process.stdout.write "Compiling $(path.basename filename) ... "
          let start-time = Date.now()
          let compilation = yield gorilla.compile code, opts
          let end-time = Date.now()
          process.stdout.write "$(((end-time - start-time) / 1000_ms).to-fixed(3)) seconds\n"
          compiled[filename] := compilation.code
        else if options.stdout or options.gjs or options.ast or options.nodes
          yield handle-code code
        else
          yield gorilla.run code, opts
    
      if not options.join
        for filename in filenames
          yield handle-single filename, input[filename]
      else
        opts.filenames := filenames
        process.stdout.write "Compiling $(filenames.join ", ") ... "
        let start-time = Date.now()
        let compilation = yield gorilla.compile (for filename in filenames; input[filename]), opts
        let end-time = Date.now()
        process.stdout.write "$(((end-time - start-time) / 1000_ms).to-fixed(3)) seconds\n"
        compiled["join"] := compilation.code
    
      let get-js-output-path(filename)
        if options.output and filenames.length == 1
          options.output
        else
          let base-dir = path.dirname filename
          let dir = if options.output
            path.join options.output, base-dir
          else
            base-dir
          path.join dir, path.basename(filename, path.extname(filename)) & ".js"
  
      let write-single = promise! #(filename, js-code)*
        let js-path = get-js-output-path filename
        let js-dir = path.dirname(js-path)
        let defer = __defer()
        fs.exists js-dir, defer.fulfill
        let exists = yield defer.promise
        if not exists
          yield to-promise! child_process.exec "mkdir -p $js-dir"
        yield to-promise! fs.write-file js-path, js-code, "utf8"
    
      if options.compile
        if not options.join
          for filename in filenames
            yield write-single filename, compiled[filename]
        else
          let js-path = if options.output
            options.output
          else
            path.join(path.dirname(filenames[0]), "out.js")
        
          yield write-single js-path, compiled.join
    
      if sourcemap?
        yield to-promise! fs.write-file options.sourcemap, opts.sourcemap.to-string(), "utf8"
      
      if options.watch
        let watch-queue = {}
        let handle-queue = do
          let mutable in-handle = false
          #
            if in-handle
              return
            in-handle := true
            let mutable lowest-time = new Date().get-time() - 1000_ms
            let mutable best-name = void
            for name, time of watch-queue
              if time < lowest-time
                lowest-time := time
                best-name := name
            if best-name?
              delete watch-queue[best-name]
              promise!
                try
                  yield handle-single best-name, input[best-name]
                  yield write-single best-name
                catch e
                  console.error e?.stack or e
                in-handle := false
                handle-queue()
            else
              in-handle := false
        for filename in filenames
          fs.watch filename, #(event, name = filename)!
            async err, code <- fs.read-file name
            input[name] := code.to-string()
            if watch-queue not ownskey name
              watch-queue[name] := new Date().get-time()
        set-interval handle-queue, 17
        console.log "Watching $(filenames.join ', ')..."
    else
      require('./repl').start(if options.gjs then { pipe: "gjs" })
  catch e
    console.error e?.stack or e
    process.exit(1)
