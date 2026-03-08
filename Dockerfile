FROM apify/actor-node-playwright-chrome:22

COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

COPY . ./

CMD ["node", "src/main.js"]
