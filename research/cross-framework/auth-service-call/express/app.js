// Auth + service call: the handler delegates to a service.
const express = require('express')
const { requireAuth } = require('./auth')
const taskService = require('./task.service')

const app = express()

app.get('/tasks/:id', requireAuth, async (req, res) => {
  res.json(await taskService.findById(req.params.id))
})

module.exports = app
