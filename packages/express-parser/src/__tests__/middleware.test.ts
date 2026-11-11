import { describe, test, expect } from "@jest/globals"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { createExpressProject } from "../project.js"
import { extractRoutes, type ExpressRoute } from "../routes.js"
import { classifyMiddleware, type ClassifyOptions } from "../middleware.js"
import { parseExpressSources } from "../adapter.js"

function routesOf(files: Record<string, string>): ExpressRoute[] {
  return extractRoutes(createExpressProject(Object.entries(files).map(([path, content]) => ({ path, content })))).routes
}

/** "name=kind+kind" for each middleware of the single route in `app.js`. */
function kindsOf(files: Record<string, string>, opts: ClassifyOptions = {}): string[] {
  const [route] = routesOf(files)
  return route.middleware.map((m) => `${m.name}=${classifyMiddleware(m, opts).kinds.join("+")}`)
}

describe("classifyMiddleware — packages", () => {
  test("auth, rate limit, validation, CSRF and infrastructure packages", () => {
    expect(kindsOf({
      "app.js": `
        const express = require('express')
        const passport = require('passport')
        const helmet = require('helmet')
        const cors = require('cors')
        const rateLimit = require('express-rate-limit')
        const { celebrate, Joi } = require('celebrate')
        const csrf = require('csurf')
        const { expressjwt } = require('express-jwt')
        const app = express()
        const limiter = rateLimit({ windowMs: 60000 })
        app.use(helmet())
        app.use(cors())
        app.use(express.json())
        app.use(passport.initialize())
        app.post('/x',
          limiter,
          passport.authenticate('jwt', { session: false }),
          expressjwt({ secret: 's', algorithms: ['HS256'] }),
          celebrate({ body: Joi.object() }),
          csrf(),
          (req, res) => {})
      `,
    })).toEqual([
      "helmet=infrastructure", "cors=infrastructure", "json=infrastructure", "initialize=infrastructure",
      "limiter=rate_limit", "authenticate=auth_gate", "expressjwt=auth_gate", "celebrate=validation_gate", "csrf=csrf",
    ])
  })

  test("express-validator chains are validation", () => {
    expect(kindsOf({
      "app.ts": `
        import express from 'express'
        import { body, param } from 'express-validator'
        const app = express()
        app.put('/users/:id', param('id').isInt(), body('email').isEmail().normalizeEmail(), (req, res) => {})
      `,
    })).toEqual(["param=validation_gate", "body=validation_gate"])
  })
})

describe("classifyMiddleware — names", () => {
  test("auth and authorization names; an auth factory with roles is both", () => {
    expect(kindsOf({
      "app.js": `
        const app = require('express')()
        app.delete('/users/:id', checkJwt, checkRole(['ADMIN']), isAdmin, auth('manageUsers'), authorize(), requireAuth, (req, res) => {})
      `,
    })).toEqual([
      "checkJwt=auth_gate", "checkRole=authz_check", "isAdmin=authz_check",
      "auth=auth_gate+authz_check", "authorize=auth_gate", "requireAuth=auth_gate",
    ])
  })

  test("validation and rate-limit names", () => {
    expect(kindsOf({
      "app.js": `
        const app = require('express')()
        app.post('/login', loginLimiter, validate(schema), validateBody(schema), (req, res) => {})
      `,
    })).toEqual(["loginLimiter=rate_limit", "validate=validation_gate", "validateBody=validation_gate"])
  })

  test("auth.required is an auth gate; auth.optional and credentialsRequired: false block nothing", () => {
    expect(kindsOf({
      "app.ts": `
        import express from 'express'
        import { expressjwt as jwt } from 'express-jwt'
        const auth = {
          required: jwt({ secret: 's', algorithms: ['HS256'] }),
          optional: jwt({ secret: 's', credentialsRequired: false, algorithms: ['HS256'] }),
        }
        const app = express()
        app.get('/feed', auth.required, auth.optional, jwt({ secret: 's', credentialsRequired: false }), (req, res) => {})
      `,
    })).toEqual(["required=auth_gate", "optional=optional_auth", "jwt=optional_auth"])
  })
})

describe("classifyMiddleware — bodies of project middleware", () => {
  test("jwt.verify is authentication; a role check that denies is authorization; an ORM scope() is neither", () => {
    expect(kindsOf({
      "app.js": `
        const app = require('express')()
        const jwt = require('jsonwebtoken')
        const apiMiddleware = async (req, res, next) => {
          const token = req.headers['x-token']
          if (!token) return res.status(401).send()
          req.user = jwt.verify(token, process.env.SECRET)
          const user = await User.scope('withSecretColumns').findOne({ where: { id: req.user.id } })
          return next()
        }
        const adminMiddleware = (req, res, next) => {
          if (req.user && req.user.isAdmin) return next()
          return res.status(403).send('Forbidden')
        }
        const tracker = (req, res, next) => {
          if (!user) return res.status(500).send()
          next()
        }
        app.get('/admin', apiMiddleware, adminMiddleware, tracker, (req, res) => {})
      `,
    })).toEqual(["apiMiddleware=auth_gate", "adminMiddleware=authz_check", "tracker=unknown"])
  })

  test("middleware that never stops a request is infrastructure; one that mentions csrf is csrf", () => {
    expect(kindsOf({
      "app.js": `
        const app = require('express')()
        const lusca = require('lusca')
        app.use((req, res, next) => { res.locals.user = req.user; next() })
        app.use((req, res, next) => { if (req.path === '/upload') next(); else lusca.csrf()(req, res, next) })
        app.get('/', (req, res) => {})
      `,
    })).toEqual(["<inline>=infrastructure", "<inline>=csrf"])
  })

  test("(err, req, res, next) is an error handler", () => {
    expect(kindsOf({
      "app.js": `
        const app = require('express')()
        function onError(err, req, res, next) { res.status(500).send() }
        app.use(onError)
        app.get('/', (req, res) => {})
      `,
    })).toEqual(["onError=error_handler"])
  })
})

describe("classifyMiddleware — archmind.json guards", () => {
  test("configured names win over every heuristic", () => {
    expect(kindsOf({
      "app.js": `
        const app = require('express')()
        app.get('/x', gatekeeper, validate(schema), passportConfig.isAuthorized, (req, res) => {})
      `,
    }, { authGates: ["gatekeeper"], authzChecks: ["validate", "passportConfig.isAuthorized"] })).toEqual([
      "gatekeeper=auth_gate", "validate=authz_check", "isAuthorized=authz_check",
    ])
  })
})

describe("parseExpressSources — classified graphs", () => {
  test("infrastructure is left out; controls become their IR nodes in order", () => {
    const [g] = parseExpressSources([{
      path: "app.js",
      content: `
        const express = require('express')
        const app = express()
        app.use(express.json())
        app.post('/orders', limiter, auth('createOrder'), validate(schema), (req, res) => {})
      `,
    }])
    expect(g.nodes.map((n) => [n.type, n.role])).toEqual([
      [IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, "rate_limiting"],
      [IR_NODE_TYPES.AUTH_GATE, "authentication"],
      [IR_NODE_TYPES.AUTHZ_CHECK, "authorization"],
      [IR_NODE_TYPES.VALIDATION_GATE, "validation"],
      [IR_NODE_TYPES.BUSINESS_HANDLER, "handler"],
    ])
    expect(g.nodes[2]).toMatchObject({ symbol: "auth('createOrder')", args: ["'createOrder'"] })
    expect(g.edges).toHaveLength(4)
  })

  test("guards from options reach the classifier", () => {
    const [g] = parseExpressSources(
      [{ path: "app.js", content: `const app = require('express')(); app.get('/x', gatekeeper, (req, res) => {})` }],
      { authGates: ["gatekeeper"] },
    )
    expect(g.nodes[0].type).toBe(IR_NODE_TYPES.AUTH_GATE)
  })
})
