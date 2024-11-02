FROM node:18-alpine
WORKDIR /app
COPY . /app
RUN npm install
EXPOSE 8080
ENV NODE_OPTIONS="--trace-warnings"
CMD ["npm","start"]