export interface GuardDescriptor {
  className: string
  args: string[]
  irType: "ir:auth_gate" | "ir:authz_check" | "unknown_guard"
}

export interface NestJSSemanticRoute {
  method: string
  path: string
  symbol: string
  controllerClass: string
  file: string
  guards: GuardDescriptor[]
  isPublic: boolean
  validationPipe: boolean
  dto: string | null
}
