FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --production

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server-12.js"]