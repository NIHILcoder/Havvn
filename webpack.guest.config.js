const path = require('path');

module.exports = {
  entry: './guest/index.ts',
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'docs/room'),
    filename: 'guest.js',
    iife: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: { configFile: 'tsconfig.guest.json' },
        },
        exclude: /node_modules/,
      },
    ],
  },
  performance: { hints: false },
};
