#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
import re
import json
import socket
import subprocess
from urllib.request import urlopen, Request
from http.server import HTTPServer, BaseHTTPRequestHandler

# 基础目录配置
DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(DASHBOARD_DIR)
RUN_REMOTE_EXP = os.path.join(PROJECT_DIR, 'run_remote.exp')

# 获取本地网卡 IP 地址
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'

# 远程执行 SSH 命令包装器 (基于 expect)
def run_remote_command(cmd_str):
    if not os.path.exists(RUN_REMOTE_EXP):
        return ""
    proc = subprocess.Popen(
        [RUN_REMOTE_EXP, cmd_str],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    stdout, _ = proc.communicate()
    output = stdout.decode('latin-1', errors='ignore')
    
    # 提取 ===START=== 和 ===END=== 之间的内容，过滤 SSH banner
    clean_lines = []
    capture = False
    for line in output.splitlines():
        if "===START===" in line:
            capture = True
            continue
        if "===END===" in line:
            capture = False
            break
        if capture:
            clean_lines.append(line)
            
    return "\n".join(clean_lines)

# Clash API 请求包装器 (远程 / 本地 Mock 回退)
CLASH_API = "http://192.168.31.1:9999"

def request_clash_api(path, method="GET", data=None):
    try:
        url = f"{CLASH_API}{path}"
        req = Request(url, method=method)
        req.add_header('Content-Type', 'application/json')
        
        body = None
        if data:
            body = json.dumps(data).encode('utf-8')
            
        with urlopen(req, data=body, timeout=2) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception:
        return None

# 设备自定义配置持久化文件路径 (本地调试回退)
def get_custom_path():
    base_dir = "/data/ShellCrash"
    if os.path.exists(base_dir):
        # 确保 configs 存在
        os.makedirs(os.path.join(base_dir, "configs"), exist_ok=True)
        return os.path.join(base_dir, "configs", "device_custom.json")
    return os.path.join(PROJECT_DIR, "device_custom.json")

# 游戏加速设备列表文件路径
def get_game_devices_path():
    base_dir = "/data/ShellCrash"
    if os.path.exists(base_dir):
        # 确保 configs 存在
        os.makedirs(os.path.join(base_dir, "configs"), exist_ok=True)
        return os.path.join(base_dir, "configs", "game_devices")
    return os.path.join(PROJECT_DIR, "game_devices")

# 路由器 Clash 配置路径
def get_config_path():
    path = "/data/ShellCrash/yamls/config.yaml"
    if os.path.exists(path):
        return path
    local_path = os.path.join(PROJECT_DIR, "config.yaml")
    if not os.path.exists(local_path):
        with open(local_path, "w", encoding="utf-8") as f:
            f.write("rules:\n  - DIRECT\n")
    return local_path

# 触发 Clash Meta 内核配置无感热重载
def trigger_clash_reload():
    try:
        config_path = get_config_path()
        request_clash_api("/configs?force=true", method="PUT", data={"path": config_path})
        print("💡 Clash Meta 无感配置热重载指令成功下发！")
    except Exception as e:
        print(f"⚠️ Clash API 重载失败: {e}，回退中...")

# 核心规则注入引擎
def update_clash_rules():
    game_macs = []
    game_path = get_game_devices_path()
    if os.path.exists(game_path):
        try:
            with open(game_path, "r", encoding="utf-8") as f:
                game_macs = [line.strip().lower() for line in f.readlines() if line.strip()]
        except Exception:
            pass

    # 获取局域网设备的 IP 映射关系
    dhcp_leases = {}
    
    # 优先读路由器 dhcp 租约，如果不存在，回退到远程获取
    dhcp_raw = ""
    if os.path.exists("/tmp/dhcp.leases"):
        try:
            with open("/tmp/dhcp.leases", "r", encoding="utf-8") as f:
                dhcp_raw = f.read()
        except Exception:
            pass
    else:
        dhcp_raw = run_remote_command("cat /tmp/dhcp.leases")
        
    for line in dhcp_raw.splitlines():
        parts = line.strip().split()
        if len(parts) >= 3:
            dhcp_leases[parts[1].lower()] = parts[2]

    # 构造 AND 条件规则：只要源 IP 是加速设备，且目标匹配任天堂域名，走专属游戏通道
    rule_lines = ["# === GAME ACC START ==="]
    for mac in game_macs:
        ip = dhcp_leases.get(mac)
        if not ip:
            # 本地 Mock 数据反查兼容，保证本地调试
            mock_ips = {
                "70:48:0f:d1:e2:b3": "192.168.31.112",
                "a0:b1:c2:d3:e4:f5": "192.168.31.42",
                "44:55:66:77:88:99": "192.168.31.66",
                "04:d4:c4:b4:a4:94": "192.168.31.115",
                "d4:fb:6a:01:02:03": "192.168.31.177"
            }
            ip = mock_ips.get(mac)
        if ip:
            # 转义 AND 里的圆括号，供远程 echo 写入文件
            rule_lines.append(f"  - AND,\\(\\(SRC-IP-CIDR,{ip}/32\\),\\(GEOSITE,nintendo\\)\\),🎮 游戏加速")
    rule_lines.append("# === GAME ACC END ===")

    # 区分开发环境与线上路由器环境
    if os.path.exists("/data/ShellCrash"):
        try:
            # 清理以前的临时文件并创建新段
            run_remote_command("rm -f /tmp/game_rules.txt")
            for line in rule_lines:
                run_remote_command(f"echo '{line}' >> /tmp/game_rules.txt")
            
            # 使用 sed 在远程删除旧规则，并将新段拉取插入在 rules: 后面
            run_remote_command("sed -i '/# === GAME ACC START ===/,/# === GAME ACC END ===/d' /data/ShellCrash/yamls/config.yaml")
            run_remote_command("sed -i '/rules:/r /tmp/game_rules.txt' /data/ShellCrash/yamls/config.yaml")
            
            # 触发内核 API 无缝重载
            run_remote_command("curl -s -X PUT -d '{\"path\": \"/data/ShellCrash/yamls/config.yaml\"}' http://127.0.0.1:9999/configs?force=true")
            print("🚀 路由器端 Clash 配置重载触发成功！")
        except Exception as e:
            print(f"路由器规则更新异常: {e}")
    else:
        # 本地 macOS 调试端：直接读写本地的 `config.yaml`
        local_config = get_config_path()
        try:
            with open(local_config, "r", encoding="utf-8") as f:
                content = f.read()
                
            # 清除老段，并移除转义字符
            clean_lines = [l.replace("\\", "") for l in rule_lines]
            content_clean = re.sub(r'# === GAME ACC START ===.*?# === GAME ACC END ===\n?', '', content, flags=re.DOTALL)
            rules_match = re.search(r'^rules:', content_clean, re.MULTILINE)
            if rules_match:
                pos = rules_match.end()
                rules_inserted = content_clean[:pos] + "\n" + "\n".join(clean_lines) + content_clean[pos:]
            else:
                rules_inserted = content_clean + "\nrules:\n" + "\n".join(clean_lines) + "\n"
                
            with open(local_config, "w", encoding="utf-8") as f:
                f.write(rules_inserted)
            print("🚀 本地模拟端 config.yaml 更新成功！")
        except Exception as e:
            print(f"本地规则更新异常: {e}")

class DashboardAPIHandler(BaseHTTPRequestHandler):
    
    # 增加 CORS 头以支持任意移动端跨域访问
    def _set_headers(self, status_code=200, content_type="application/json"):
        self.send_response(status_code)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        
    def do_OPTIONS(self):
        self._set_headers(200)

    def do_GET(self):
        # 静态网页资源服务
        if self.path == "/" or self.path == "/index.html":
            self._serve_static("index.html", "text/html")
        elif self.path == "/style.css":
            self._serve_static("style.css", "text/css")
        elif self.path == "/app.js":
            self._serve_static("app.js", "application/javascript")
            
        # API 路由
        elif self.path == "/api/status":
            self.get_status()
        elif self.path == "/api/devices":
            self.get_devices()
        elif self.path == "/api/game/list":
            self.get_game_list()
        else:
            self.send_error(404, "File Not Found")
            
    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
        except Exception:
            content_length = 0
        post_data = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else ""
        
        try:
            data = json.loads(post_data) if post_data else {}
        except Exception:
            data = {}
            
        if self.path == "/api/whitelist/add":
            self.add_whitelist(data.get("mac"))
        elif self.path == "/api/whitelist/remove":
            self.remove_whitelist(data.get("mac"))
        elif self.path == "/api/game/enable":
            self.enable_game(data.get("mac"))
        elif self.path == "/api/game/disable":
            self.disable_game(data.get("mac"))
        elif self.path == "/api/devices/custom":
            self.save_device_custom(data.get("mac"), data.get("name"), data.get("category"))
        else:
            self.send_error(404, "API Not Found")

    # 静态文件服务辅助
    def _serve_static(self, filename, content_type):
        filepath = os.path.join(DASHBOARD_DIR, 'static', filename)
        if os.path.exists(filepath):
            self._set_headers(200, content_type)
            with open(filepath, 'rb') as f:
                self.wfile.write(f.read())
        else:
            self.send_error(404, "Static file not found")

    # API 接口实现：获取运行状态
    def get_status(self):
        status_res = {
            "active": False,
            "pid": "",
            "memory": "0 kB",
            "version": "未知",
            "mode": "未知",
            "allow_lan": False
        }
        
        remote_pid = run_remote_command("pidof CrashCore")
        pid = remote_pid.strip()
        
        if pid.isdigit():
            status_res["active"] = True
            status_res["pid"] = pid
            
            mem_info = run_remote_command(f"cat /proc/{pid}/status | grep VmRSS")
            if "VmRSS:" in mem_info:
                status_res["memory"] = mem_info.split("VmRSS:")[-1].strip()
                
            clash_version = request_clash_api("/version")
            if clash_version:
                status_res["version"] = clash_version.get("version", "未知")
                
            clash_config = request_clash_api("/configs")
            if clash_config:
                status_res["mode"] = clash_config.get("mode", "未知")
                status_res["allow_lan"] = clash_config.get("allow-lan", False)
                
        self._set_headers(200)
        self.wfile.write(json.dumps(status_res).encode('utf-8'))

    # API 接口实现：获取局域网设备与白名单 (合并自定义属性)
    def get_devices(self):
        # 1. 获取已加白名单的 MAC
        whitelist = []
        if os.path.exists("/data/ShellCrash/configs/mac"):
            try:
                with open("/data/ShellCrash/configs/mac", "r", encoding="utf-8") as f:
                    whitelist = [line.strip().lower() for line in f.readlines() if line.strip()]
            except Exception:
                pass
        else:
            whitelist_raw = run_remote_command("cat /data/ShellCrash/configs/mac")
            whitelist = [line.strip().lower() for line in whitelist_raw.splitlines() if line.strip()]
        
        # 2. 获取 DHCP 租约设备
        dhcp_raw = ""
        if os.path.exists("/tmp/dhcp.leases"):
            try:
                with open("/tmp/dhcp.leases", "r", encoding="utf-8") as f:
                    dhcp_raw = f.read()
            except Exception:
                pass
        else:
            dhcp_raw = run_remote_command("cat /tmp/dhcp.leases")
            
        lan_devices = []
        for line in dhcp_raw.splitlines():
            parts = line.strip().split()
            if len(parts) >= 4:
                mac = parts[1].lower()
                ip = parts[2]
                hostname = parts[3]
                if hostname == "*":
                    hostname = "未知设备"
                lan_devices.append({
                    "mac": mac,
                    "ip": ip,
                    "hostname": hostname
                })
                
        # 3. 读取自定义设备命名与分类
        custom_data = {}
        custom_path = get_custom_path()
        if os.path.exists(custom_path):
            try:
                with open(custom_path, "r", encoding="utf-8") as f:
                    custom_data = json.load(f)
            except Exception:
                pass
                
        response = {
            "whitelist": whitelist,
            "lan_devices": lan_devices,
            "custom": custom_data
        }
        self._set_headers(200)
        self.wfile.write(json.dumps(response).encode('utf-8'))

    # API 接口实现：添加 MAC 到白名单
    def add_whitelist(self, mac):
        if not mac:
            self._set_headers(400)
            self.wfile.write(json.dumps({"success": False, "message": "MAC address is required"}).encode('utf-8'))
            return
            
        mac = mac.strip().lower()
        cmd = f"echo '{mac}' >> /data/ShellCrash/configs/mac && awk '!a[$0]++' /data/ShellCrash/configs/mac > /tmp/mac_clean && mv /tmp/mac_clean /data/ShellCrash/configs/mac && /data/ShellCrash/start.sh restart"
        run_remote_command(cmd)
        
        self._set_headers(200)
        self.wfile.write(json.dumps({"success": True}).encode('utf-8'))

    # API 接口实现：从白名单移除 MAC
    def remove_whitelist(self, mac):
        if not mac:
            self._set_headers(400)
            self.wfile.write(json.dumps({"success": False, "message": "MAC address is required"}).encode('utf-8'))
            return
            
        mac = mac.strip().lower()
        cmd = f"grep -v -F -i '{mac}' /data/ShellCrash/configs/mac > /tmp/mac_clean ; mv /tmp/mac_clean /data/ShellCrash/configs/mac ; /data/ShellCrash/start.sh restart"
        run_remote_command(cmd)
        
        self._set_headers(200)
        self.wfile.write(json.dumps({"success": True}).encode('utf-8'))

    # API 接口实现：获取开启了游戏加速的设备列表
    def get_game_list(self):
        game_path = get_game_devices_path()
        game_macs = []
        if os.path.exists(game_path):
            try:
                with open(game_path, "r", encoding="utf-8") as f:
                    game_macs = [line.strip().lower() for line in f.readlines() if line.strip()]
            except Exception:
                pass
        self._set_headers(200)
        self.wfile.write(json.dumps(game_macs).encode('utf-8'))

    # API 接口实现：为特定设备开启游戏加速
    def enable_game(self, mac):
        if not mac:
            self._set_headers(400)
            self.wfile.write(json.dumps({"success": False, "message": "MAC is required"}).encode('utf-8'))
            return
            
        mac = mac.strip().lower()
        game_path = get_game_devices_path()
        
        game_macs = []
        if os.path.exists(game_path):
            try:
                with open(game_path, "r", encoding="utf-8") as f:
                    game_macs = [line.strip().lower() for line in f.readlines() if line.strip()]
            except Exception:
                pass
                
        if mac not in game_macs:
            game_macs.append(mac)
            try:
                with open(game_path, "w", encoding="utf-8") as f:
                    for m in game_macs:
                        f.write(f"{m}\n")
            except Exception as e:
                print(f"写入 game_devices 失败: {e}")
                
        # 触发规则引擎与热重载
        update_clash_rules()
        
        self._set_headers(200)
        self.wfile.write(json.dumps({"success": True}).encode('utf-8'))

    # API 接口实现：关闭特定设备的游戏加速
    def disable_game(self, mac):
        if not mac:
            self._set_headers(400)
            self.wfile.write(json.dumps({"success": False, "message": "MAC is required"}).encode('utf-8'))
            return
            
        mac = mac.strip().lower()
        game_path = get_game_devices_path()
        
        game_macs = []
        if os.path.exists(game_path):
            try:
                with open(game_path, "r", encoding="utf-8") as f:
                    game_macs = [line.strip().lower() for line in f.readlines() if line.strip()]
            except Exception:
                pass
                
        if mac in game_macs:
            game_macs = [m for m in game_macs if m != mac]
            try:
                with open(game_path, "w", encoding="utf-8") as f:
                    for m in game_macs:
                        f.write(f"{m}\n")
            except Exception as e:
                print(f"写入 game_devices 失败: {e}")
                
        # 触发规则引擎与热重载
        update_clash_rules()
        
        self._set_headers(200)
        self.wfile.write(json.dumps({"success": True}).encode('utf-8'))

    # API 接口实现：保存自定义设备名字和分类
    def save_device_custom(self, mac, name, category):
        if not mac:
            self._set_headers(400)
            self.wfile.write(json.dumps({"success": False, "message": "MAC is required"}).encode('utf-8'))
            return
            
        mac = mac.strip().lower()
        custom_path = get_custom_path()
        
        custom_data = {}
        if os.path.exists(custom_path):
            try:
                with open(custom_path, "r", encoding="utf-8") as f:
                    custom_data = json.load(f)
            except Exception:
                pass
                
        custom_data[mac] = {
            "name": name or "",
            "category": category or "other"
        }
        
        try:
            with open(custom_path, "w", encoding="utf-8") as f:
                json.dump(custom_data, f, indent=4, ensure_ascii=False)
        except Exception as e:
            print(f"写入 device_custom.json 失败: {e}")
            
        self._set_headers(200)
        self.wfile.write(json.dumps({"success": True}).encode('utf-8'))

def start_server(port=8080):
    local_ip = get_local_ip()
    server_address = ('0.0.0.0', port)
    httpd = HTTPServer(server_address, DashboardAPIHandler)
    
    print("=" * 60)
    print(" 🎉  Router Clash 移动端控制台后端服务已成功启动！")
    print(f" 🖥️  本地访问地址: http://localhost:{port}")
    print(f" 📱  移动端访问地址 (iPad/iPhone): http://{local_ip}:{port}")
    print("=" * 60)
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭 Web 服务...")
        httpd.server_close()
        sys.exit(0)

if __name__ == '__main__':
    port = 8080
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    start_server(port)
