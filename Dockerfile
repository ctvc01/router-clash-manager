FROM node:18-alpine

RUN apk add --no-cache expect openssh-client curl sshpass iptables

# 配置 SSH 客户端支持 RSA host keys（老旧路由器兼容性）
RUN mkdir -p /root/.ssh

COPY ssh_config /root/.ssh/config
RUN chmod 600 /root/.ssh/config

WORKDIR /app

# 拷贝依赖配置并安装
COPY package.json ./
RUN npm install --registry=https://registry.npmmirror.com

# 拷贝其余源码（aliases.json 自动在 server.js 中初始化）
COPY . .

# 赋予 Expect 脚本和 SSH wrapper 可执行权限
RUN chmod +x ssh_exec.exp ssh_wrapper.sh

EXPOSE 3000

CMD ["node", "src/server.js"]
