import {copyFileSync,readFileSync,writeFileSync} from 'node:fs';
writeFileSync('dist/index.html',readFileSync('index.html','utf8').replace('/src/main.ts','./main.js').replace('/src/style.css','./style.css'));
copyFileSync('src/style.css','dist/style.css');
