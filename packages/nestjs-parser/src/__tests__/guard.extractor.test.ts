import { Project } from "ts-morph"
import { extractGuards } from "../extractors/guard.extractor.js"

function makeProject(source: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { strict: false, noEmit: true },
  })
  project.createSourceFile("test.ts", source)
  return project.getSourceFileOrThrow("test.ts")
}

describe("extractGuards — single auth guard", () => {
  test("AuthGuard('jwt') → ir:auth_gate with strategy arg", () => {
    const sf = makeProject(`
      class C {
        @UseGuards(AuthGuard('jwt'))
        doX() {}
      }
    `)
    const decs = sf.getClassOrThrow("C").getMethodOrThrow("doX").getDecorators()
    const guards = extractGuards(decs)
    expect(guards).toHaveLength(1)
    expect(guards[0].className).toBe("AuthGuard")
    expect(guards[0].irType).toBe("ir:auth_gate")
    expect(guards[0].args).toEqual(["jwt"])
  })

  test("JwtAuthGuard plain class → ir:auth_gate", () => {
    const sf = makeProject(`
      class C {
        @UseGuards(JwtAuthGuard)
        doX() {}
      }
    `)
    const decs = sf.getClassOrThrow("C").getMethodOrThrow("doX").getDecorators()
    const guards = extractGuards(decs)
    expect(guards[0].irType).toBe("ir:auth_gate")
    expect(guards[0].args).toHaveLength(0)
  })
})

describe("extractGuards — authz guard + @Roles metadata", () => {
  test("RolesGuard + @Roles('admin') → ir:authz_check with args", () => {
    const sf = makeProject(`
      class C {
        @UseGuards(RolesGuard)
        @Roles('admin')
        doX() {}
      }
    `)
    const decs = sf.getClassOrThrow("C").getMethodOrThrow("doX").getDecorators()
    const guards = extractGuards(decs)
    expect(guards).toHaveLength(1)
    expect(guards[0].irType).toBe("ir:authz_check")
    expect(guards[0].args).toEqual(["admin"])
  })

  test("multiple @Roles values collected", () => {
    const sf = makeProject(`
      class C {
        @UseGuards(RolesGuard)
        @Roles('admin', 'superadmin')
        doX() {}
      }
    `)
    const decs = sf.getClassOrThrow("C").getMethodOrThrow("doX").getDecorators()
    const guards = extractGuards(decs)
    expect(guards[0].args).toEqual(["admin", "superadmin"])
  })
})

describe("extractGuards — multiple guards in one @UseGuards", () => {
  test("@UseGuards(JwtAuthGuard, RolesGuard) → two descriptors", () => {
    const sf = makeProject(`
      class C {
        @UseGuards(JwtAuthGuard, RolesGuard)
        @Roles('admin')
        doX() {}
      }
    `)
    const decs = sf.getClassOrThrow("C").getMethodOrThrow("doX").getDecorators()
    const guards = extractGuards(decs)
    expect(guards).toHaveLength(2)
    expect(guards[0].irType).toBe("ir:auth_gate")
    expect(guards[1].irType).toBe("ir:authz_check")
    expect(guards[1].args).toEqual(["admin"])
  })
})

describe("extractGuards — unknown guard", () => {
  test("CustomBusinessGuard → unknown_guard", () => {
    const sf = makeProject(`
      class C {
        @UseGuards(CustomBusinessGuard)
        doX() {}
      }
    `)
    const decs = sf.getClassOrThrow("C").getMethodOrThrow("doX").getDecorators()
    const guards = extractGuards(decs)
    expect(guards[0].irType).toBe("unknown_guard")
    expect(guards[0].className).toBe("CustomBusinessGuard")
  })
})
