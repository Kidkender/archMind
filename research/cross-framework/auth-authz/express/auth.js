const jwt = require('jsonwebtoken')

exports.requireAuth = (req, res, next) => {
  try {
    req.user = jwt.verify(req.headers.authorization, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).end()
  }
}

exports.requireRole = (role) => (req, res, next) => {
  if (req.user.roles.includes(role)) return next()
  res.status(403).end()
}
