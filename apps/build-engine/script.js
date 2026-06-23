const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const mime = require('mime-types')
const Redis = require('ioredis')

const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
})

const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID
const DEPLOYMENT_SLUG = process.env.DEPLOYMENT_SLUG
const S3_BUCKET = process.env.S3_BUCKET || 'dreamer-outputs'
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'singularitydev.xyz'

// Same channel carries both log lines and status events — api-server's
// src/realtime/log-relay.ts tells them apart by `type`. Keep this contract
// in sync BY HAND with src/realtime/realtime.types.ts on the API server —
// there's no shared package between this app (plain Node) and that one
// (TypeScript) to enforce it for you.
const CHANNEL = `deployment:${DEPLOYMENT_ID}`

function publishLog(message, level = 'INFO', source = 'build') {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'log', level, message, source }))
}

function publishStatus(status, extra = {}) {
    publisher.publish(CHANNEL, JSON.stringify({ type: 'status', status, ...extra }))
}

// Helper function to run the build sequentially
function runBuildCommand(dirPath) {
    return new Promise((resolve, reject) => {
        const p = exec(`cd ${dirPath} && npm install && npm run build`)

        p.stdout.on('data', function (data) {
            console.log(data.toString())
            publishLog(data.toString())
        })

        // stderr is mostly npm warning chatter and build-tool progress
        // output, not necessarily a fatal error — WARN, not ERROR. The
        // build's actual pass/fail signal is the exit code in p.on('close'),
        // not which stream a given line happened to print to.
        p.stderr.on('data', function (data) {
            console.error(data.toString())
            publishLog(data.toString(), 'WARN')
        })

        p.on('close', function (code) {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`Build process exited with code ${code}`))
            }
        })
    })
}

async function init() {
    console.log('Executing script.js')
    publishLog('Build started', 'SYSTEM')
    publishStatus('BUILDING')

    const outDirPath = path.join(__dirname, 'output')

    try {
        // 1. Wait for the build to completely finish
        await runBuildCommand(outDirPath)

        console.log('Build Complete')
        publishLog('Build complete', 'SYSTEM')

        const distFolderPath = path.join(__dirname, 'output', 'dist')

        // Safety check to ensure the framework actually built a 'dist' folder
        if (!fs.existsSync(distFolderPath)) {
            throw new Error(`Build finished but expected output directory 'dist' was not found at ${distFolderPath}`)
        }

        publishStatus('UPLOADING')
        publishLog('Starting upload to S3', 'SYSTEM', 'platform')

        const distFolderContents = fs.readdirSync(distFolderPath, { recursive: true })
        let uploadedCount = 0

        for (const file of distFolderContents) {
            const filePath = path.join(distFolderPath, file)
            if (fs.lstatSync(filePath).isDirectory()) continue;

            console.log('uploading', filePath)
            publishLog(`uploading ${file}`, 'INFO', 'platform')

            // __outputs/{DEPLOYMENT_SLUG}/... — keyed by the DEPLOYMENT's
            // slug now, not the project's. This is what Deployment.s3Prefix
            // in schema.prisma documents ("__outputs/{slug}/") and it's why
            // apps/reverse-proxy needs NO changes at all: it already proxies
            // subdomain -> __outputs/{subdomain}, and the subdomain a user
            // visits IS this deployment's slug.
            const command = new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: `__outputs/${DEPLOYMENT_SLUG}/${file}`,
                Body: fs.createReadStream(filePath),
                ContentType: mime.lookup(filePath) || 'application/octet-stream'
            })

            await s3Client.send(command)
            uploadedCount++
            publishLog(`uploaded ${file}`, 'INFO', 'platform')
        }

        const url = `https://${DEPLOYMENT_SLUG}.${BASE_DOMAIN}`
        publishLog(`Done — ${uploadedCount} files uploaded`, 'SYSTEM')
        publishStatus('RUNNING', { url })
        console.log('Done...')
    } catch (error) {
        console.error('Fatal execution error:', error.message)
        publishLog(`Fatal error: ${error.message}`, 'ERROR', 'platform')
        publishStatus('FAILED', { errorMessage: error.message, errorCode: 'BUILD_FAILED', errorStep: 'build' })
        process.exitCode = 1
    } finally {
        // publisher.publish() is fire-and-forget over an already-open
        // connection — give the last message a moment to actually flush
        // over the socket before the process (and the whole Fargate task)
        // exits.
        setTimeout(() => publisher.quit(), 250)
    }
}

init()
