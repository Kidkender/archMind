import { Project } from "ts-morph"
import { extractDto } from "../extractors/dto.extractor.js"

function makeMethod(source: string, methodName = "doX") {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { strict: false, noEmit: true },
  })
  project.createSourceFile("test.ts", source)
  return project.getSourceFileOrThrow("test.ts")
    .getClassOrThrow("C")
    .getMethodOrThrow(methodName)
}

describe("extractDto — validation pipe detection", () => {
  test("@UsePipes(new ValidationPipe()) sets validationPipe=true", () => {
    const method = makeMethod(`
      class C {
        @UsePipes(new ValidationPipe())
        doX(@Body() dto: CreateUserDto) {}
      }
    `)
    const { validationPipe, dto } = extractDto(method)
    expect(validationPipe).toBe(true)
    expect(dto).toBe("CreateUserDto")
  })

  test("@UsePipes(ValidationPipe) without new also sets true", () => {
    const method = makeMethod(`
      class C {
        @UsePipes(ValidationPipe)
        doX(@Body() dto: CreateUserDto) {}
      }
    `)
    expect(extractDto(method).validationPipe).toBe(true)
  })

  test("no @UsePipes → validationPipe=false", () => {
    const method = makeMethod(`
      class C {
        doX(@Body() dto: CreateUserDto) {}
      }
    `)
    expect(extractDto(method).validationPipe).toBe(false)
  })
})

describe("extractDto — DTO detection", () => {
  test("@Body() param with type → dto name extracted", () => {
    const method = makeMethod(`
      class C {
        doX(@Body() dto: UpdateUserDto) {}
      }
    `)
    expect(extractDto(method).dto).toBe("UpdateUserDto")
  })

  test("no @Body() param → dto=null", () => {
    const method = makeMethod(`
      class C {
        doX(@Param('id') id: string) {}
      }
    `)
    expect(extractDto(method).dto).toBeNull()
  })

  test("@Body() without type annotation → dto=null", () => {
    const method = makeMethod(`
      class C {
        doX(@Body() body) {}
      }
    `)
    expect(extractDto(method).dto).toBeNull()
  })
})
