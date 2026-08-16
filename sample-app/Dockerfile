FROM node:22-alpine

WORKDIR /app

COPY package.json server.js ./

ENV PORT=3000
EXPOSE 3000

USER node

CMD ["npm", "start"]
