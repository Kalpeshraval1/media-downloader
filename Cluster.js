'use strict';
// ═══════════════════════════════════════════════════════════
//  cluster.js — Multi-core Node.js launcher
//  Use this on Railway Paid / VPS (not Render free tier)
//  Usage:  node cluster.js
//  Start script in package.json:  "start:cluster": "node cluster.js"
// ═══════════════════════════════════════════════════════════
const cluster = require('cluster');
const os      = require('os');

const WORKERS = parseInt(process.env.WEB_CONCURRENCY || os.cpus().length);

if (cluster.isPrimary) {
  console.log(`[CLUSTER] Primary ${process.pid} starting ${WORKERS} workers`);

  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[CLUSTER] Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });

  cluster.on('online', worker => {
    console.log(`[CLUSTER] Worker ${worker.process.pid} online`);
  });

} else {
  // Workers run the actual server
  require('./server.js');
}
