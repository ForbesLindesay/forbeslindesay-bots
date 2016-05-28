if (process.env.NODE_ENV === 'production') {
  require('./lib/index.js');
} else {
  require('babel-register');
  require('./src/index.js');
}
