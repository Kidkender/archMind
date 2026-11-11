import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

/**
 * Whether a validation gate can carry authorization, as Laravel's
 * FormRequest::authorize() does. Elsewhere — NestJS ValidationPipe, Spring
 * @Valid, Gin binding tags, Express celebrate / express-validator — a
 * validation gate only checks the input. A graph without a framework tag is a
 * legacy or hand-built Laravel graph and keeps the Laravel meaning.
 */
export function validationCanAuthorize(graph: IntermediateExecutionGraph): boolean {
  return !graph.framework || graph.framework === "laravel"
}
