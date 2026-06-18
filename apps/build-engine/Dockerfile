FROM node:22-alpine
RUN apk add --no-cache git bash
WORKDIR /home/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN chmod +x main.sh
ENTRYPOINT ["/home/app/main.sh"]