# どのPaaS/VPSでも動く自己完結イメージ
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# PaaS は PORT を注入する。未指定なら 8080
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]
