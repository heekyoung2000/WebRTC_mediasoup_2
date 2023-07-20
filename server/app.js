const express = require('express')
const port = 3000; //3000번 포트
const host = '43.201.47.117';
const app = express();
app.get('/', (req, res) => {
  res.send('Hello World!')
});
app.listen(port, host);
console.log('server start!')
