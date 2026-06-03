import type { MethodDeclaration } from "ts-morph"

export interface DtoInfo {
  dto: string | null
  validationPipe: boolean
}

export function extractDto(method: MethodDeclaration): DtoInfo {
  let dto: string | null = null
  let validationPipe = false

  // @UsePipes(ValidationPipe) or @UsePipes(new ValidationPipe(...))
  for (const dec of method.getDecorators()) {
    if (dec.getName() !== "UsePipes") continue
    const args = dec.getCallExpression()?.getArguments() ?? []
    if (args.some(a => a.getText().includes("ValidationPipe"))) {
      validationPipe = true
    }
  }

  // @Body() param with DTO type annotation
  for (const param of method.getParameters()) {
    if (!param.getDecorator("Body")) continue
    const typeNode = param.getTypeNode()
    if (typeNode) dto = typeNode.getText()
  }

  return { dto, validationPipe }
}
