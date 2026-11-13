// Auth + authorization: authenticated, then a role check for "editor".
const express = require('express')
const { requireAuth, requireRole } = require('./auth')

const app = express()
app.use(express.json())

app.put('/tasks/:id', requireAuth, requireRole('editor'), (req, res) => {
  res.json({ id: req.params.id })
})

module.exports = app
