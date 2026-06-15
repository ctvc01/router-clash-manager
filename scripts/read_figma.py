#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
import json
import urllib.parse
from urllib.request import Request, urlopen
from urllib.error import HTTPError

def parse_figma_url(url):
    """
    解析 Figma URL，提取 file_key 和 node_id
    示例：https://www.figma.com/design/ABCD1234efgh5678/My-Project?node-id=12-345&t=xyz
    """
    parsed = urllib.parse.urlparse(url)
    path_parts = parsed.path.strip("/").split("/")
    
    file_key = None
    # 路径通常是 /design/FILE_KEY/...、/file/FILE_KEY/... 或 /proto/FILE_KEY/...
    if len(path_parts) >= 2 and path_parts[0] in ("design", "file", "proto"):
        file_key = path_parts[1]
    
    # 提取 query 中的 node-id
    query_params = urllib.parse.parse_qs(parsed.query)
    node_ids = query_params.get("node-id", [])
    node_id = node_ids[0] if node_ids else None
    
    # Figma URL 中的 node-id 可能使用 '-' 代替 ':'，例如 '12-345' 在 API 中应为 '12:345'
    if node_id:
        node_id = node_id.replace("-", ":")
        
    return file_key, node_id

def clean_node(node):
    """
    递归精简 Figma 节点数据，只保留与布局和样式相关的核心属性，减小 context 大小
    """
    if not node:
        return None
        
    cleaned = {
        "id": node.get("id"),
        "name": node.get("name"),
        "type": node.get("type"),
    }
    
    # 如果节点不可见，直接返回
    if node.get("visible") is False:
        return None
        
    # 保留 bounding box (位置和大小)
    bbox = node.get("absoluteBoundingBox") or node.get("absoluteRenderBounds")
    if bbox:
        cleaned["bounds"] = {
            "x": round(bbox.get("x", 0), 1),
            "y": round(bbox.get("y", 0), 1),
            "width": round(bbox.get("width", 0), 1),
            "height": round(bbox.get("height", 0), 1)
        }
        
    # 文本内容
    if "characters" in node:
        cleaned["text"] = node.get("characters")
        
    # 文本样式
    style = node.get("style")
    if style:
        cleaned["text_style"] = {
            "fontFamily": style.get("fontFamily"),
            "fontSize": style.get("fontSize"),
            "fontWeight": style.get("fontWeight"),
            "textAlignHorizontal": style.get("textAlignHorizontal"),
            "textAlignVertical": style.get("textAlignVertical"),
        }
        # 移除空值
        cleaned["text_style"] = {k: v for k, v in cleaned["text_style"].items() if v is not None}
        if not cleaned["text_style"]:
            del cleaned["text_style"]
            
    # 填充颜色 (简易版)
    fills = node.get("fills", [])
    valid_fills = []
    for fill in fills:
        if fill.get("visible") is False:
            continue
        fill_info = {"type": fill.get("type")}
        if fill.get("color"):
            color = fill.get("color")
            # 转换为 0-255 整数表示的 rgba
            r = int(color.get("r", 0) * 255)
            g = int(color.get("g", 0) * 255)
            b = int(color.get("b", 0) * 255)
            a = color.get("a", 1)
            fill_info["color"] = f"rgba({r}, {g}, {b}, {a:.2f})"
        if fill.get("opacity") is not None:
            fill_info["opacity"] = fill.get("opacity")
        valid_fills.append(fill_info)
    if valid_fills:
        cleaned["fills"] = valid_fills
        
    # 布局模式 (Flex 布局相关)
    for layout_prop in ("layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode", 
                        "primaryAxisAlignItems", "counterAxisAlignItems", "paddingLeft", 
                        "paddingRight", "paddingTop", "paddingBottom", "itemSpacing"):
        if layout_prop in node:
            if "layout" not in cleaned:
                cleaned["layout"] = {}
            cleaned["layout"][layout_prop] = node[layout_prop]
            
    # 递归处理子节点
    if "children" in node:
        cleaned_children = []
        for child in node["children"]:
            child_clean = clean_node(child)
            if child_clean:
                cleaned_children.append(child_clean)
        if cleaned_children:
            cleaned["children"] = cleaned_children
            
    return cleaned

def format_as_markdown(node, depth=0):
    """
    将精简后的节点树格式化为易读的 Markdown 文本
    """
    indent = "  " * depth
    node_type = node.get("type", "UNKNOWN")
    node_name = node.get("name", "Unnamed")
    bounds = node.get("bounds", {})
    bounds_str = f" [{bounds.get('width')}x{bounds.get('height')} @ {bounds.get('x')},{bounds.get('y')}]" if bounds else ""
    
    text_content = f' "{node.get("text")}"' if "text" in node else ""
    
    lines = [f"{indent}- **{node_name}** ({node_type}){bounds_str}{text_content}"]
    
    # 打印布局和样式细节
    if "fills" in node:
        colors = [f.get("color") for f in node["fills"] if "color" in f]
        if colors:
            lines.append(f"{indent}  * Fills: {', '.join(colors)}")
            
    if "layout" in node and node["layout"].get("layoutMode"):
        lines.append(f"{indent}  * Layout: {node['layout']['layoutMode']} (spacing: {node['layout'].get('itemSpacing')})")
        
    if "children" in node:
        for child in node["children"]:
            lines.extend(format_as_markdown(child, depth + 1))
            
    return lines

def fetch_figma_data(file_key, node_id, api_key):
    """
    发送 API 请求获取 Figma 节点数据
    """
    if node_id:
        url = f"https://api.figma.com/v1/files/{file_key}/nodes?ids={urllib.parse.quote(node_id)}"
    else:
        url = f"https://api.figma.com/v1/files/{file_key}"
        
    req = Request(url)
    req.add_header("X-Figma-Token", api_key)
    
    try:
        with urlopen(req) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as e:
        print(f"Error fetching data from Figma API: HTTP {e.code} - {e.reason}", file=sys.stderr)
        if e.code == 403:
            print("Please check if your Figma Personal Access Token is correct and has access to this file.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Failed to connect to Figma API: {str(e)}", file=sys.stderr)
        sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print("Usage: python read_figma.py <Figma_URL> [FIGMA_API_KEY]")
        print("Or set FIGMA_API_KEY environment variable.")
        sys.exit(1)
        
    figma_url = sys.argv[1]
    
    # 优先从命令行第二个参数读取，其次从环境变量读取
    api_key = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("FIGMA_API_KEY")
    
    if not api_key:
        print("Error: FIGMA_API_KEY is not set. Please pass it as the second argument or set the environment variable.", file=sys.stderr)
        sys.exit(1)
        
    file_key, node_id = parse_figma_url(figma_url)
    if not file_key:
        print(f"Error: Could not parse Figma URL: {figma_url}", file=sys.stderr)
        sys.exit(1)
        
    print(f"Parsed File Key: {file_key}")
    if node_id:
        print(f"Parsed Node ID: {node_id}")
    else:
        print("No specific Node ID provided. Fetching entire file.")
        
    print("Fetching data from Figma API...")
    raw_data = fetch_figma_data(file_key, node_id, api_key)
    
    # 提取目标节点
    cleaned_root = None
    if node_id:
        nodes_dict = raw_data.get("nodes", {})
        node_container = nodes_dict.get(node_id) or list(nodes_dict.values())[0]
        if node_container and "document" in node_container:
            cleaned_root = clean_node(node_container["document"])
    else:
        if "document" in raw_data:
            cleaned_root = clean_node(raw_data["document"])
            
    if not cleaned_root:
        print("Error: Could not extract target node from Figma API response.", file=sys.stderr)
        sys.exit(1)
        
    # 保存精简后的 JSON 和 Markdown 到当前工作目录中
    output_json_path = os.path.join(os.getcwd(), "figma_nodes.json")
    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(cleaned_root, f, indent=2, ensure_ascii=False)
    print(f"Successfully saved clean node data to: {output_json_path}")
    
    markdown_lines = format_as_markdown(cleaned_root)
    output_md_path = os.path.join(os.getcwd(), "figma_nodes.md")
    with open(output_md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(markdown_lines))
    print(f"Successfully saved design hierarchy to: {output_md_path}")
    
    # 打印前 50 行，展示预览
    print("\n--- Design Hierarchy Preview ---")
    for line in markdown_lines[:50]:
        print(line)
    if len(markdown_lines) > 50:
        print(f"... and {len(markdown_lines) - 50} more lines (see figma_nodes.md)")

if __name__ == "__main__":
    main()
