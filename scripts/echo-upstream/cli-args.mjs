const VALUE_OPTIONS = new Map([
  ['--port', (args, value) => { args.port = Number(value) }],
  ['--log', (args, value) => { args.log = value }],
  ['--tokens', (args, value) => { args.tokens = value.split(',').map(Number) }],
  ['--models', (args, value) => { args.models = value.split(',').map((model) => model.trim()).filter(Boolean) }],
])

const BOOLEAN_OPTIONS = new Map([
  ['--echo-user-message', (args) => { args.echoUserMessage = true }],
])

export function parseArgs(argv, defaults) {
  const args = { ...defaults }
  for (let index = 0; index < argv.length;) {
    const option = argv[index]
    const booleanHandler = BOOLEAN_OPTIONS.get(option)
    if (booleanHandler) {
      booleanHandler(args)
      index += 1
      continue
    }
    const valueHandler = VALUE_OPTIONS.get(option)
    if (!valueHandler || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`无效参数或缺少值: ${option}`)
    }
    valueHandler(args, argv[index + 1])
    index += 2
  }
  return args
}
