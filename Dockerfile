FROM node:18-alpine
WORKDIR /app
COPY . /app
RUN npm install
RUN wget -O- https://raw.githubusercontent.com/jwils0n/profanity-filter/master/lib/seeds/profanity.json > node_modules/profanity-filter/lib/seeds/profanity.json
EXPOSE 8080
CMD ["npm","start"]