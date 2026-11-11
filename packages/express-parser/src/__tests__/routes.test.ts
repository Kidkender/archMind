import { describe, test, expect } from "@jest/globals"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { createExpressProject } from "../project.js"
import { extractRoutes, joinPath, type ExpressRoute } from "../routes.js"
import { parseExpressSources } from "../adapter.js"
import type { SourceFile } from "../scanner.js"

function routesOf(files: Record<string, string>): ExpressRoute[] {
  const sources: SourceFile[] = Object.entries(files).map(([path, content]) => ({ path, content }))
  return extractRoutes(createExpressProject(sources)).routes
}

function keys(routes: ExpressRoute[]): string[] {
  return routes.map((r) => `${r.method} ${r.path}`).sort()
}

function route(routes: ExpressRoute[], key: string): ExpressRoute {
  const r = routes.find((x) => `${x.method} ${x.path}` === key)
  if (!r) throw new Error(`no route ${key}; have ${keys(routes).join(", ")}`)
  return r
}

const names = (r: ExpressRoute) => r.middleware.map((m) => m.name)

describe("extractRoutes — registration", () => {
  test("routes registered on the app in one file", () => {
    const routes = routesOf({
      "app.js": `
        const express = require('express')
        const app = express()
        app.get('/health', (req, res) => res.send('ok'))
        app.post('/items', createItem)
        app.delete(\`/items/:id\`, removeItem)
        function createItem(req, res) {}
        function removeItem(req, res) {}
      `,
    })
    expect(keys(routes)).toEqual(["DELETE /items/:id", "GET /health", "POST /items"])
    expect(route(routes, "POST /items").handler).toMatchObject({ symbol: "createItem", file: "app.js", line: 7 })
    expect(route(routes, "GET /health").handler.symbol).toBe("<inline>")
  })

  test("a router in another CommonJS file, mounted with a prefix", () => {
    const routes = routesOf({
      "src/app.js": `
        const express = require('express')
        const users = require('./routes/users')
        const app = express()
        app.use('/api/users', users)
      `,
      "src/routes/users.js": `
        const router = require('express').Router()
        router.get('/', list)
        router.get('/:id', show)
        function list() {}
        function show() {}
        module.exports = router
      `,
    })
    expect(keys(routes)).toEqual(["GET /api/users", "GET /api/users/:id"])
  })

  test("ES modules: named Router import, chained use, a default export built in one expression", () => {
    const routes = routesOf({
      "src/main.ts": `
        import express from 'express'
        import routes from './routes'
        const app = express()
        app.use(routes)
      `,
      "src/routes/index.ts": `
        import { Router } from 'express'
        import tags from './tags'
        import articles from './articles'
        const api = Router().use(tags).use(articles)
        export default Router().use('/api', api)
      `,
      "src/routes/tags.ts": `
        import { Router } from 'express'
        const router = Router()
        router.get('/tags', async (req, res) => {})
        export default router
      `,
      "src/routes/articles.ts": `
        import { Router } from 'express'
        export const router = Router()
        router.post('/articles', async (req, res) => {})
        export default router
      `,
    })
    expect(keys(routes)).toEqual(["GET /api/tags", "POST /api/articles"])
  })

  test("router.route() chains register one route per verb", () => {
    const routes = routesOf({
      "app.js": `
        const express = require('express')
        const router = express.Router()
        router
          .route('/:userId')
          .get(ctrl.get)
          .patch(ctrl.update)
          .delete(ctrl.remove)
        const ctrl = { get() {}, update() {}, remove() {} }
        const app = express()
        app.use('/users', router)
      `,
    })
    expect(keys(routes)).toEqual(["DELETE /users/:userId", "GET /users/:userId", "PATCH /users/:userId"])
  })

  test("routers mounted from an array in a forEach keep each path with its own router", () => {
    const routes = routesOf({
      "routes/index.js": `
        const express = require('express')
        const authRoute = require('./auth')
        const userRoute = require('./user')
        const router = express.Router()
        const defaultRoutes = [
          { path: '/auth', route: authRoute },
          { path: '/users', route: userRoute },
        ]
        defaultRoutes.forEach((route) => {
          router.use(route.path, route.route)
        })
        module.exports = router
      `,
      "routes/auth.js": `
        const router = require('express').Router()
        router.post('/login', (req, res) => {})
        module.exports = router
      `,
      "routes/user.js": `
        const router = require('express').Router()
        router.get('/', (req, res) => {})
        module.exports = router
      `,
    })
    expect(keys(routes)).toEqual(["GET /users", "POST /auth/login"])
  })

  test("a registrar function handed the app registers on it", () => {
    const routes = routesOf({
      "server.js": `
        const express = require('express')
        const app = express()
        require('./routes')(app)
      `,
      "routes.js": `
        module.exports = function (app) {
          app.get('/a', (req, res) => {})
          app.post('/b', (req, res) => {})
        }
      `,
    })
    expect(keys(routes)).toEqual(["GET /a", "POST /b"])
  })

  test("calls that are not on a router are ignored, and so is app.get(setting)", () => {
    const routes = routesOf({
      "app.js": `
        const express = require('express')
        const axios = require('axios')
        const app = express()
        const cache = new Map()
        cache.get('/x', 1)
        axios.get('/remote', { timeout: 1 })
        const env = app.get('env')
        app.get('/real', (req, res) => {})
      `,
    })
    expect(keys(routes)).toEqual(["GET /real"])
  })

  test("a path that cannot be resolved to a string is reported, not guessed", () => {
    const { routes, unresolvedPaths } = extractRoutes(createExpressProject([{
      path: "app.js",
      content: `
        const app = require('express')()
        for (const url of getUrls()) app.get(url, (req, res) => {})
      `,
    }]))
    expect(routes).toEqual([])
    expect(unresolvedPaths).toEqual([{ file: "app.js", line: 3, text: "url" }])
  })

  test("path constants and concatenation resolve", () => {
    const routes = routesOf({
      "app.js": `
        const express = require('express')
        const API = '/api'
        const VERSION = 'v2'
        const app = express()
        app.get(API + '/' + VERSION + '/ping', (req, res) => {})
        app.get(\`\${API}/status\`, (req, res) => {})
      `,
    })
    expect(keys(routes)).toEqual(["GET /api/status", "GET /api/v2/ping"])
  })
})

describe("extractRoutes — middleware chain", () => {
  test("app.use middleware applies to routes registered after it, in order", () => {
    const routes = routesOf({
      "app.js": `
        const express = require('express')
        const app = express()
        app.get('/before', (req, res) => {})
        app.use(helmet())
        app.use(express.json())
        app.get('/after', (req, res) => {})
        app.use(lateMiddleware)
      `,
    })
    expect(names(route(routes, "GET /before"))).toEqual([])
    expect(names(route(routes, "GET /after"))).toEqual(["helmet", "json"])
  })

  test("path-scoped middleware runs only under its path; route-level middleware follows it", () => {
    const routes = routesOf({
      "app.js": `
        const express = require('express')
        const app = express()
        app.use('/admin', requireAdmin)
        app.get('/admin/stats', audit, (req, res) => {})
        app.get('/administrators', (req, res) => {})
        app.get('/public', (req, res) => {})
      `,
    })
    expect(names(route(routes, "GET /admin/stats"))).toEqual(["requireAdmin", "audit"])
    expect(names(route(routes, "GET /administrators"))).toEqual([])
    expect(names(route(routes, "GET /public"))).toEqual([])
  })

  test("middleware passed in an array, or in a constant holding one, is spread out", () => {
    const routes = routesOf({
      "user.ts": `
        import { Router } from 'express'
        import { checkJwt } from './checkJwt'
        import { checkRole } from './checkRole'
        const adminOnly = [checkJwt, checkRole(['ADMIN'])]
        const router = Router()
        router.get('/', [checkJwt, checkRole(['ADMIN'])], list)
        router.delete('/:id', adminOnly, remove)
        export default router
      `,
    })
    for (const key of ["GET /", "DELETE /:id"]) {
      const r = route(routes, key)
      expect(names(r)).toEqual(["checkJwt", "checkRole"])
      expect(r.middleware[1].args).toEqual(["['ADMIN']"])
    }
  })

  test("middleware on a parent applies to a mounted router; use(path, mw, router) applies mw to it", () => {
    const routes = routesOf({
      "app.js": `
        const express = require('express')
        const api = require('./api')
        const app = express()
        app.use(cors())
        app.use('/api', authenticate, api)
      `,
      "api.js": `
        const router = require('express').Router()
        router.use(rateLimit)
        router.get('/me', (req, res) => {})
        module.exports = router
      `,
    })
    expect(names(route(routes, "GET /api/me"))).toEqual(["cors", "authenticate", "rateLimit"])
  })
})

describe("extractRoutes — handlers", () => {
  test("controller methods from a CommonJS module, an exports object, and a class", () => {
    const routes = routesOf({
      "routes.js": `
        const express = require('express')
        const userController = require('./user.controller')
        const { list } = require('./list.controller')
        const UserController = require('./UserController')
        const router = express.Router()
        router.post('/users', userController.create)
        router.get('/users', list)
        router.get('/users/:id', UserController.getOne)
        module.exports = router
      `,
      "user.controller.js": `
        exports.create = async (req, res) => {}
      `,
      "list.controller.js": `
        const list = (req, res) => {}
        module.exports = { list }
      `,
      "UserController.js": `
        class UserController {
          static getOne = async (req, res) => {}
        }
        module.exports = UserController
      `,
    })
    expect(route(routes, "POST /users").handler).toMatchObject({ symbol: "userController.create", file: "user.controller.js", line: 2 })
    expect(route(routes, "GET /users").handler).toMatchObject({ symbol: "list", file: "list.controller.js", line: 2 })
    expect(route(routes, "GET /users/:id").handler).toMatchObject({ symbol: "UserController.getOne", file: "UserController.js", line: 3 })
  })

  test("a wrapper (catchAsync) and .bind are looked through to the handler", () => {
    const routes = routesOf({
      "routes.js": `
        const express = require('express')
        const catchAsync = (fn) => (req, res, next) => fn(req, res, next).catch(next)
        const ctrl = require('./ctrl')
        const router = express.Router()
        router.get('/a', ctrl.a)
        router.get('/b', catchAsync(ctrl.b))
        router.get('/c', ctrl.c.bind(ctrl))
        router.get('/d', catchAsync(async (req, res) => {}))
        module.exports = router
      `,
      "ctrl.js": `
        const catchAsync = require('./catchAsync')
        const a = catchAsync(async (req, res) => {})
        const b = async (req, res) => {}
        function c(req, res) {}
        module.exports = { a, b, c }
      `,
      "catchAsync.js": `
        module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
      `,
    })
    expect(route(routes, "GET /a").handler).toMatchObject({ symbol: "ctrl.a", file: "ctrl.js", line: 3 })
    expect(route(routes, "GET /b").handler).toMatchObject({ symbol: "ctrl.b", file: "ctrl.js", line: 4 })
    expect(route(routes, "GET /c").handler).toMatchObject({ symbol: "ctrl.c", file: "ctrl.js", line: 5 })
    expect(route(routes, "GET /d").handler).toMatchObject({ symbol: "<inline>", file: "routes.js", line: 9 })
  })

  test("a call that wraps no project function keeps its own text", () => {
    const routes = routesOf({
      "docs.js": `
        const express = require('express')
        const swaggerUi = require('swagger-ui-express')
        const router = express.Router()
        router.get('/', swaggerUi.setup(specs))
        module.exports = router
      `,
    })
    expect(route(routes, "GET /").handler.symbol).toBe("swaggerUi.setup(specs)")
  })
})

describe("parseExpressSources — graphs", () => {
  test("one graph per route: middleware then handler, linked by precedes", () => {
    const [g] = parseExpressSources([{
      path: "app.js",
      content: `
        const app = require('express')()
        app.post('/orders', authenticate, validate(schema), (req, res) => {})
      `,
    }])
    expect(g.entrypoint).toBe("POST /orders")
    expect(g.framework).toBe("express")
    expect(g.nodes.map((n) => n.type)).toEqual([
      IR_NODE_TYPES.AUTH_GATE, IR_NODE_TYPES.VALIDATION_GATE, IR_NODE_TYPES.BUSINESS_HANDLER,
    ])
    expect(g.nodes[1]).toMatchObject({ symbol: "validate(schema)", args: ["schema"], file: "app.js", line: 3 })
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["mw_0->mw_1", "mw_1->handler"])
  })
})

describe("joinPath", () => {
  test("joins prefixes without doubled or trailing slashes", () => {
    expect(joinPath("", "/")).toBe("/")
    expect(joinPath("/api", "/")).toBe("/api")
    expect(joinPath("/api/", "/users/")).toBe("/api/users")
    expect(joinPath("", "users")).toBe("/users")
    expect(joinPath("/v1", "*")).toBe("/v1/*")
  })
})
