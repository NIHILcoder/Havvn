const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const fs = require('fs');

module.exports = (env, argv) => ({
  entry: {
    startup: './renderer/startup.ts',
    bundle: { import: './renderer/index.tsx', dependOn: 'startup' },
  },
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: '[name].js',
    publicPath: argv.mode === 'production' ? './' : '/',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.renderer.json',
          },
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
      {
        // World-map geometry for the swarm map. Parsed as JSON but kept off the
        // .json extension so TypeScript's resolveJsonModule doesn't try to infer
        // a literal type for the whole ~800KB file (huge/slow).
        test: /\.geojson$/,
        type: 'json',
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './renderer/index.html',
      filename: 'index.html',
      chunks: ['startup', 'bundle'],
      chunksSortMode: 'manual',
      templateParameters: {
        startupCss: fs.readFileSync(path.join(__dirname, 'renderer/startup.css'), 'utf8'),
        appVersion: require('./package.json').version,
      },
    }),
  ],
});
