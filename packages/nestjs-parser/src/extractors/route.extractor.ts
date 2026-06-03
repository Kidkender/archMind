import { Project } from "ts-morph"
import type { Decorator } from "ts-morph"
import path from "path"
import type { NestJSSemanticRoute } from "../types.js"
import { extractGuards } from "./guard.extractor.js"
import { extractDto } from "./dto.extractor.js"

const HTTP_METHOD_MAP: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE",
  Patch: "PATCH", Options: "OPTIONS", Head: "HEAD", All: "ALL",
}

export interface RouteExtractorOptions {
  projectRoot: string
  tsConfigPath?: string
}

export function extractRoutes(options: RouteExtractorOptions): NestJSSemanticRoute[] {
  const { projectRoot } = options

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true, skipLibCheck: true, strict: false },
  })

  project.addSourceFilesAtPaths(
    path.join(projectRoot, "**/*.controller.ts").replace(/\\/g, "/")
  )

  const routes: NestJSSemanticRoute[] = []

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = path
      .relative(projectRoot, sourceFile.getFilePath())
      .replace(/\\/g, "/")

    for (const cls of sourceFile.getClasses()) {
      const controllerDec = cls.getDecorator("Controller")
      if (!controllerDec) continue

      const prefix = resolveControllerPrefix(controllerDec)
      const controllerGuards = extractGuards(cls.getDecorators())
      const controllerIsPublic = Boolean(cls.getDecorator("Public"))

      for (const method of cls.getMethods()) {
        const httpDec = method.getDecorators().find(d => HTTP_METHOD_MAP[d.getName()])
        if (!httpDec) continue

        const httpMethod = HTTP_METHOD_MAP[httpDec.getName()]
        const methodPath = resolveMethodPath(httpDec)
        const fullPath = joinPaths(prefix, methodPath)

        const methodIsPublic = Boolean(method.getDecorator("Public"))
        const isPublic = controllerIsPublic || methodIsPublic

        const methodGuards = extractGuards(method.getDecorators())
        // @Public() suppresses guard inheritance from controller level
        const guards = isPublic ? [] : [...controllerGuards, ...methodGuards]

        const { dto, validationPipe } = extractDto(method)

        routes.push({
          method: httpMethod,
          path: fullPath,
          symbol: `${cls.getName() ?? "UnknownController"}::${method.getName()}`,
          controllerClass: cls.getName() ?? "UnknownController",
          file: filePath,
          guards,
          isPublic,
          validationPipe,
          dto,
        })
      }
    }
  }

  return routes
}

function resolveControllerPrefix(dec: Decorator): string {
  const args = dec.getCallExpression()?.getArguments() ?? []
  if (!args.length) return "/"
  const raw = args[0].getText().replace(/['"]/g, "")
  return raw.startsWith("/") ? raw : `/${raw}`
}

function resolveMethodPath(dec: Decorator): string {
  const args = dec.getCallExpression()?.getArguments() ?? []
  if (!args.length) return ""
  return args[0].getText().replace(/['"]/g, "")
}

function joinPaths(prefix: string, suffix: string): string {
  const p = prefix === "/" ? "" : prefix.replace(/\/$/, "")
  const s = suffix ? (suffix.startsWith("/") ? suffix : `/${suffix}`) : ""
  return `${p}${s}` || "/"
}
