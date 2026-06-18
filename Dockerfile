FROM node:20-alpine

# 安装 expect、openssh-client、curl 和 sshpass 支持SSH隧道
RUN apk add --no-cache expect openssh-client curl sshpass

WORKDIR /app

# 拷贝依赖配置并安装
COPY package.json ./
RUN npm install --registry=https://registry.npmmirror.com

# 拷贝其余源码（aliases.json 自动在 server.js 中初始化）
COPY . .

# 赋予 Expect 脚本可执行权限
RUN chmod +x ssh_exec.exp

EXPOSE 3000

CMD ["node", "src/server.js"]
