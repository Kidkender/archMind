import { Project, ScriptKind, type SourceFile as TsSourceFile } from "ts-morph"
import type { SourceFile } from "./scanner.js"

/**
 * An in-memory ts-morph project over the given files. Paths stay relative to the
 * project root (mounted at "/"), so node file/line come out project-relative.
 * Module resolution between files is done by the extractors themselves, not
 * by the TypeScript checker: JavaScript `require()` and
 * re-exports need the same handling as ES imports, and no tsconfig is read.
 */
export interface ExpressProject {
  project: Project
  /** Project-relative path ("src/app.js") → source file. */
  files:   Map<string, TsSourceFile>
}

export function createExpressProject(sources: SourceFile[]): ExpressProject {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, strict: false },
  })
  const files = new Map<string, TsSourceFile>()
  for (const source of sources) {
    const scriptKind = /\.[cm]?ts$/.test(source.path) ? ScriptKind.TS : ScriptKind.JS
    files.set(source.path, project.createSourceFile(`/${source.path}`, source.content, { scriptKind, overwrite: true }))
  }
  return { project, files }
}

/** The project-relative path of a source file created by createExpressProject. */
export function relativePath(file: TsSourceFile): string {
  return file.getFilePath().replace(/^\//, "")
}
