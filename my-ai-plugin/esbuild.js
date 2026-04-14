// @ts-check
const esbuild = require('esbuild');

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
// 后端入口：TypeScript → dist/extension.js
const extensionBuildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true,
};

/** @type {import('esbuild').BuildOptions} */
// 前端 Webview 脚本：media/*.js → dist/media/*.js
// 生产模式下压缩混淆，去除注释，增加逆向难度
const mediaBuildOptions = {
  entryPoints: [
    'media/chat.js',
    'media/chat_a_render.js',
    'media/chat_b_steps.js',
  ],
  bundle: false,        // 前端脚本之间不做模块捆绑，保持独立文件
  outdir: 'dist/media',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,     // 生产包不附带 sourcemap，防止源码泄露
  minify: isProduction,
  // 生产模式下额外处理：删除所有注释、压缩标识符
  legalComments: isProduction ? 'none' : 'inline',
  // 开发模式不压缩，保留可读性方便调试
};

async function main() {
  if (isWatch) {
    // 开发模式：同时监听后端和前端文件变化
    const extCtx = await esbuild.context(extensionBuildOptions);
    const mediaCtx = await esbuild.context(mediaBuildOptions);
    await extCtx.watch();
    await mediaCtx.watch();
    console.log('[esbuild] 监听模式已启动，等待文件变化...');
  } else {
    // 构建模式：一次性打包后端 + 前端
    await esbuild.build(extensionBuildOptions);
    await esbuild.build(mediaBuildOptions);
    console.log('[esbuild] 构建完成');
  }
}

main().catch((err) => {
  console.error('[esbuild] 构建失败:', err);
  process.exit(1);
});
