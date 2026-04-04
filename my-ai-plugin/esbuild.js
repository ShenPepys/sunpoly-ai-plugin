// @ts-check
const esbuild = require('esbuild');

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
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

async function main() {
  if (isWatch) {
    // 开发模式：监听文件变化自动重新打包
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] 监听模式已启动，等待文件变化...');
  } else {
    // 构建模式：一次性打包
    await esbuild.build(buildOptions);
    console.log('[esbuild] 构建完成');
  }
}

main().catch((err) => {
  console.error('[esbuild] 构建失败:', err);
  process.exit(1);
});
