import fs from 'fs';
import Promise from 'promise';
import express from 'express';
import {json} from 'body-parser';

const app = express();

fs.readdirSync(__dirname + '/bots').forEach(bot => {
  const botModule = require('./bots/' + bot);
  const name = bot.replace(/\.js$/, '');
  app.post('/' + name, json(), (req, res, next) => {
    console.dir(req.body);
    let body = {};
    if (req.body != null && typeof req.body === 'object') {
      body = req.body;
    }
    Promise.resolve(botModule.default(body)).done(result => res.json(result), next);
  });
});

app.listen(process.env.PORT || 3000);
