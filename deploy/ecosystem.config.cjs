// PM2 process definition — start with: pm2 start deploy/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'prompt-mux',
      cwd: __dirname + '/../server',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 5050,
      },
      instances: 1, // single instance: SSE streams are stateful per-process
      exec_mode: 'fork',
      max_memory_restart: '512M',
      out_file: '../logs/server.out.log',
      error_file: '../logs/server.err.log',
      time: true,
    },
  ],
};
