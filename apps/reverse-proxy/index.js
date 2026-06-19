const express = require('express')
const httpProxy = require('http-proxy')
const app = express()

const PORT = process.env.PORT || 8000
const BASE_PATH = 'https://dreamer-outputs.s3.ap-south-1.amazonaws.com/__outputs'
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'singularitydev.xyz'

const proxy = httpProxy.createProxy()

// CURRENT: projectSlug -> subdomain -> s3 bucket path
// FUTURE TODO: projectSlug -> subdomain -> deployment record in DB -> latest deploymentId -> s3 bucket path
app.use((req, res) => {
    const hostname = req.hostname // e.g. "myapp.singularitydev.xyz"
    const subdomain = hostname.split('.')[0] // "myapp"
    // TODO: replace with real DB lookup mapping subdomain -> deployment/project slug
    const resolvesTo = `${BASE_PATH}/${subdomain}`
    return proxy.web(req, res, { target: resolvesTo, changeOrigin: true })
})

proxy.on('proxyReq', (proxyReq, req, _res) => {
    const url = req.url
    if (url === '/') {
        proxyReq.path += 'index.html'
    }
})

app.listen(PORT, () => console.log(`Reverse Proxy Server running on port ${PORT}`))