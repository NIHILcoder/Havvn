const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
module.exports = {
  mode: 'development', devtool: false, target: 'web',
  entry: path.resolve(__dirname, 'fixtures/room-sync-ui.tsx'),
  output: { path: path.resolve(__dirname, '../dist/room-sync-ui'), filename: 'fixture.js' },
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
  module: { rules: [
    { test: /\.tsx?$/, exclude: /node_modules/, use: { loader: 'ts-loader', options: { transpileOnly: true, configFile: path.resolve(__dirname, '../tsconfig.renderer.json'), compilerOptions: { rootDir: '..' } } } },
    { test: /\.css$/, use: ['style-loader', 'css-loader'] },
    { test: /\.woff2?$/, type: 'asset/resource' },
  ] },
  plugins: [new HtmlWebpackPlugin({ templateContent: '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Havvn sync fixture</title></head><body><div id="root"></div></body></html>' })],
  performance: { hints: false },
};
