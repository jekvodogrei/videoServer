# Вкажіть базовий образ
FROM node:20

# Встановіть ffmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Встановіть робочу директорію всередині контейнера
WORKDIR /

# Скопіюйте package.json і package-lock.json (якщо є)
COPY package*.json ./

# Встановіть залежності
RUN npm install

# Скопіюйте решту коду програми
COPY . .

# Відкрийте порт
EXPOSE 3007

# Вкажіть команду для запуску додатка
CMD ["node", "server.js"]