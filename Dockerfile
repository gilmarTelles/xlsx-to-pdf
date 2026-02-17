FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

ENV HOST=0.0.0.0
ENV PORT=3001

EXPOSE 3001

CMD ["node", "index.js"]
