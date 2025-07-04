const express = require('express');
const app = express();

app.get('/hello', (req, res) => {
  res.send('Hello World!');
});


app.get('/', (req, res) => {
    res.send('Deployed here');
  });




  
module.exports = app;
