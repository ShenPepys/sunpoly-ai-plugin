#!/usr/bin/env python3
"""
Python AST Worker — 通过 stdin/stdout JSON 协议与 VS Code 插件通信。

依赖：libcst（pip install libcst）
协议：
  请求（stdin，每行一个 JSON）：
    { "id": "req-1", "action": "add_import", "filePath": "...", "fileContent": "...", "params": {...} }
  响应（stdout，每行一个 JSON）：
    成功：{ "id": "req-1", "success": true, "files": [{ "filePath": "...", "newContent": "..." }] }
    失败：{ "id": "req-1", "success": false, "reason": "错误原因" }
  特殊：
    { "action": "ping" } → { "id": "...", "success": true, "pong": true }
    { "action": "shutdown" } → 退出进程
"""

import json
import sys
import traceback
from typing import Any, Dict, List, Optional, Sequence

try:
    import libcst as cst
    from libcst import matchers as m
    HAS_LIBCST = True
except ImportError:
    HAS_LIBCST = False


# ─── 工具函数 ──────────────────────────────────────────────

def fail(request_id: str, reason: str) -> Dict[str, Any]:
    return {"id": request_id, "success": False, "reason": reason}


def success(request_id: str, file_path: str, new_content: str) -> Dict[str, Any]:
    return {
        "id": request_id,
        "success": True,
        "files": [{"filePath": file_path, "newContent": new_content}],
    }


# ─── add_import ────────────────────────────────────────────

class AddImportTransformer(cst.CSTTransformer):
    """添加 import 语句。如果目标模块已有 from ... import，则合并。"""

    def __init__(self, module_path: str, names: Optional[List[str]] = None,
                 default_import: Optional[str] = None):
        super().__init__()
        self.module_path = module_path
        self.names = names or []
        self.default_import = default_import
        self.merged = False

    def leave_ImportFrom(
        self, original_node: cst.ImportFrom, updated_node: cst.ImportFrom
    ) -> cst.ImportFrom:
        """如果已有同模块的 from import，合并新名称。"""
        if self.merged or not self.names:
            return updated_node

        # 提取模块名
        mod_name = _get_module_name(updated_node)
        if mod_name != self.module_path:
            return updated_node

        # 只处理 names 是列表的情况（不是 star import）
        if not isinstance(updated_node.names, (list, tuple)):
            return updated_node

        existing_names = {_get_import_alias_name(alias) for alias in updated_node.names}
        new_aliases = []
        for name in self.names:
            if name not in existing_names:
                new_aliases.append(cst.ImportAlias(name=cst.Name(name)))

        if not new_aliases:
            self.merged = True
            return updated_node

        # 确保已有别名都有逗号
        existing_list = list(updated_node.names)
        if existing_list and not existing_list[-1].comma:
            existing_list[-1] = existing_list[-1].with_changes(
                comma=cst.Comma(whitespace_after=cst.SimpleWhitespace(" "))
            )

        all_aliases = existing_list + new_aliases
        self.merged = True
        return updated_node.with_changes(names=all_aliases)

    def leave_Module(
        self, original_node: cst.Module, updated_node: cst.Module
    ) -> cst.Module:
        """如果没有合并到已有 import，在文件顶部插入新行。"""
        if self.merged:
            return updated_node

        new_stmts: List[cst.BaseCompoundStatement | cst.SimpleStatementLine] = []

        if self.names:
            aliases = [cst.ImportAlias(name=cst.Name(n)) for n in self.names]
            import_node = cst.SimpleStatementLine(body=[
                cst.ImportFrom(
                    module=_build_attribute(self.module_path),
                    names=aliases,
                )
            ])
            new_stmts.append(import_node)

        if self.default_import:
            import_node = cst.SimpleStatementLine(body=[
                cst.Import(names=[
                    cst.ImportAlias(
                        name=_build_attribute(self.module_path),
                        asname=cst.AsName(
                            whitespace_before_as=cst.SimpleWhitespace(" "),
                            whitespace_after_as=cst.SimpleWhitespace(" "),
                            name=cst.Name(self.default_import),
                        ),
                    )
                ])
            ])
            new_stmts.append(import_node)

        if new_stmts:
            # 找到最后一条 import 语句的位置，在其后插入
            insert_idx = _find_last_import_index(updated_node.body)
            body = list(updated_node.body)
            for i, stmt in enumerate(new_stmts):
                body.insert(insert_idx + 1 + i, stmt)
            return updated_node.with_changes(body=body)

        return updated_node


# ─── remove_import ─────────────────────────────────────────

class RemoveImportTransformer(cst.CSTTransformer):
    """删除 import 语句。如果指定 names，只删除部分；否则删整条。"""

    def __init__(self, module_path: str, names: Optional[List[str]] = None):
        super().__init__()
        self.module_path = module_path
        self.names = names

    def leave_ImportFrom(
        self, original_node: cst.ImportFrom, updated_node: cst.ImportFrom
    ) -> cst.ImportFrom | cst.RemovalSentinel:
        mod_name = _get_module_name(updated_node)
        if mod_name != self.module_path:
            return updated_node

        # 不指定具体名称 → 删除整条
        if not self.names:
            return cst.RemovalSentinel.REMOVE

        if not isinstance(updated_node.names, (list, tuple)):
            return updated_node

        remaining = [
            alias for alias in updated_node.names
            if _get_import_alias_name(alias) not in self.names
        ]

        if not remaining:
            return cst.RemovalSentinel.REMOVE

        # 去掉最后一个别名的尾逗号
        remaining[-1] = remaining[-1].with_changes(comma=cst.MaybeSentinel.DEFAULT)
        return updated_node.with_changes(names=remaining)


# ─── insert_function ───────────────────────────────────────

def do_insert_function(tree: cst.Module, params: Dict[str, Any]) -> cst.Module:
    """在模块级插入函数定义。"""
    func_code = params["functionCode"]
    insert_after = params.get("insertAfter")
    insert_before = params.get("insertBefore")

    # 解析新函数为 CST 节点
    new_stmt = cst.parse_statement(func_code)

    body = list(tree.body)

    if insert_after:
        idx = _find_function_index(body, insert_after)
        if idx is None:
            raise ValueError(f"未找到锚点函数 {insert_after}")
        body.insert(idx + 1, new_stmt)
    elif insert_before:
        idx = _find_function_index(body, insert_before)
        if idx is None:
            raise ValueError(f"未找到锚点函数 {insert_before}")
        body.insert(idx, new_stmt)
    else:
        body.append(new_stmt)

    return tree.with_changes(body=body)


# ─── edit_function_body ────────────────────────────────────

class EditFunctionBodyTransformer(cst.CSTTransformer):
    """替换指定函数的函数体。"""

    def __init__(self, function_name: str, new_body: str):
        super().__init__()
        self.function_name = function_name
        self.found = False

    def leave_FunctionDef(
        self, original_node: cst.FunctionDef, updated_node: cst.FunctionDef
    ) -> cst.FunctionDef:
        if updated_node.name.value != self.function_name:
            return updated_node
        self.found = True
        # 用 new_body 替换整个函数体
        new_body_stmts = cst.parse_module(self._new_body_code).body
        indented = cst.IndentedBlock(body=new_body_stmts)
        return updated_node.with_changes(body=indented)

    def __init__(self, function_name: str, new_body: str):
        super().__init__()
        self.function_name = function_name
        self._new_body_code = new_body
        self.found = False


# ─── add_function_param ────────────────────────────────────

class AddFunctionParamTransformer(cst.CSTTransformer):
    """给指定函数添加参数。"""

    def __init__(self, function_name: str, param_code: str, position: Optional[int] = None):
        super().__init__()
        self.function_name = function_name
        self.param_code = param_code
        self.position = position
        self.found = False

    def leave_FunctionDef(
        self, original_node: cst.FunctionDef, updated_node: cst.FunctionDef
    ) -> cst.FunctionDef:
        if updated_node.name.value != self.function_name:
            return updated_node
        self.found = True

        # 解析新参数
        temp_func = cst.parse_statement(f"def _temp({self.param_code}): pass")
        if isinstance(temp_func, cst.FunctionDef):
            new_param = temp_func.params.params[0]
        else:
            raise ValueError(f"无法解析参数代码：{self.param_code}")

        params = list(updated_node.params.params)

        # 确保已有参数都有逗号
        if params:
            params[-1] = params[-1].with_changes(
                comma=cst.Comma(whitespace_after=cst.SimpleWhitespace(" "))
            )

        if self.position is not None and self.position < len(params):
            # 在指定位置插入，确保新参数有逗号
            new_param = new_param.with_changes(
                comma=cst.Comma(whitespace_after=cst.SimpleWhitespace(" "))
            )
            params.insert(self.position, new_param)
        else:
            params.append(new_param)

        new_parameters = updated_node.params.with_changes(params=params)
        return updated_node.with_changes(params=new_parameters)


# ─── add_class_member ──────────────────────────────────────

class AddClassMemberTransformer(cst.CSTTransformer):
    """给指定 class 添加方法或属性。"""

    def __init__(self, class_name: str, member_code: str, insert_after: Optional[str] = None):
        super().__init__()
        self.class_name = class_name
        self.member_code = member_code
        self.insert_after = insert_after
        self.found = False

    def leave_ClassDef(
        self, original_node: cst.ClassDef, updated_node: cst.ClassDef
    ) -> cst.ClassDef:
        if updated_node.name.value != self.class_name:
            return updated_node
        self.found = True

        new_member = cst.parse_statement(self.member_code)
        body = updated_node.body
        if not isinstance(body, cst.IndentedBlock):
            return updated_node

        stmts = list(body.body)

        if self.insert_after:
            idx = _find_method_index(stmts, self.insert_after)
            if idx is not None:
                stmts.insert(idx + 1, new_member)
            else:
                stmts.append(new_member)
        else:
            stmts.append(new_member)

        new_body = body.with_changes(body=stmts)
        return updated_node.with_changes(body=new_body)


# ─── rename_symbol ─────────────────────────────────────────

class RenameSymbolTransformer(cst.CSTTransformer):
    """简单的全文件符号重命名（基于名称匹配）。"""

    def __init__(self, old_name: str, new_name: str):
        super().__init__()
        self.old_name = old_name
        self.new_name = new_name
        self.count = 0

    def leave_Name(
        self, original_node: cst.Name, updated_node: cst.Name
    ) -> cst.Name:
        if updated_node.value == self.old_name:
            self.count += 1
            return updated_node.with_changes(value=self.new_name)
        return updated_node


# ─── 辅助函数 ──────────────────────────────────────────────

def _get_module_name(node: cst.ImportFrom) -> str:
    """从 ImportFrom 节点提取模块名字符串。"""
    if node.module is None:
        return ""
    return _attribute_to_str(node.module)


def _attribute_to_str(node) -> str:
    if isinstance(node, cst.Name):
        return node.value
    if isinstance(node, cst.Attribute):
        return f"{_attribute_to_str(node.value)}.{node.attr.value}"
    return ""


def _build_attribute(dotted: str):
    """将 'a.b.c' 转成嵌套的 Attribute/Name 节点。"""
    parts = dotted.split(".")
    if len(parts) == 1:
        return cst.Name(parts[0])
    result = cst.Name(parts[0])
    for part in parts[1:]:
        result = cst.Attribute(value=result, attr=cst.Name(part))
    return result


def _get_import_alias_name(alias: cst.ImportAlias) -> str:
    if isinstance(alias.name, cst.Name):
        return alias.name.value
    return _attribute_to_str(alias.name)


def _find_last_import_index(body: Sequence) -> int:
    """找到模块 body 中最后一条 import 语句的索引，没有则返回 -1。"""
    last_idx = -1
    for i, stmt in enumerate(body):
        if isinstance(stmt, cst.SimpleStatementLine):
            for item in stmt.body:
                if isinstance(item, (cst.Import, cst.ImportFrom)):
                    last_idx = i
                    break
    return last_idx


def _find_function_index(body: list, name: str) -> Optional[int]:
    """在模块级 body 中找到指定函数定义的索引。"""
    for i, stmt in enumerate(body):
        if isinstance(stmt, cst.FunctionDef) and stmt.name.value == name:
            return i
    return None


def _find_method_index(body: list, name: str) -> Optional[int]:
    """在 class body 中找到指定方法定义的索引。"""
    for i, stmt in enumerate(body):
        if isinstance(stmt, cst.FunctionDef) and stmt.name.value == name:
            return i
    return None


# ─── 分发器 ────────────────────────────────────────────────

def dispatch(request: Dict[str, Any]) -> Dict[str, Any]:
    """处理单个请求并返回响应。"""
    req_id = request.get("id", "unknown")
    action = request.get("action", "")

    if action == "ping":
        return {"id": req_id, "success": True, "pong": True}

    if action == "shutdown":
        return {"id": req_id, "success": True, "shutdown": True}

    file_path = request.get("filePath", "")
    file_content = request.get("fileContent", "")
    params = request.get("params", {})

    try:
        tree = cst.parse_module(file_content)
    except Exception as e:
        return fail(req_id, f"Python 源码解析失败：{e}")

    try:
        if action == "add_import":
            transformer = AddImportTransformer(
                module_path=params.get("modulePath", ""),
                names=params.get("namedImports"),
                default_import=params.get("defaultImport"),
            )
            new_tree = tree.visit(transformer)

        elif action == "remove_import":
            transformer = RemoveImportTransformer(
                module_path=params.get("modulePath", ""),
                names=params.get("namedImports"),
            )
            new_tree = tree.visit(transformer)

        elif action == "insert_function":
            new_tree = do_insert_function(tree, params)

        elif action == "edit_function_body":
            transformer = EditFunctionBodyTransformer(
                function_name=params.get("functionName", ""),
                new_body=params.get("newBody", "pass"),
            )
            new_tree = tree.visit(transformer)
            if not transformer.found:
                return fail(req_id, f"未找到函数 {params.get('functionName')}")

        elif action == "add_function_param":
            transformer = AddFunctionParamTransformer(
                function_name=params.get("functionName", ""),
                param_code=params.get("paramCode", ""),
                position=params.get("position"),
            )
            new_tree = tree.visit(transformer)
            if not transformer.found:
                return fail(req_id, f"未找到函数 {params.get('functionName')}")

        elif action == "add_class_member":
            transformer = AddClassMemberTransformer(
                class_name=params.get("className", ""),
                member_code=params.get("memberCode", ""),
                insert_after=params.get("insertAfter"),
            )
            new_tree = tree.visit(transformer)
            if not transformer.found:
                return fail(req_id, f"未找到类 {params.get('className')}")

        elif action == "rename_symbol":
            transformer = RenameSymbolTransformer(
                old_name=params.get("oldName", ""),
                new_name=params.get("newName", ""),
            )
            new_tree = tree.visit(transformer)
            if transformer.count == 0:
                return fail(req_id, f"未找到符号 {params.get('oldName')}")

        else:
            return fail(req_id, f"不支持的操作类型：{action}")

        new_content = new_tree.code
        return success(req_id, file_path, new_content)

    except Exception as e:
        return fail(req_id, f"{action} 操作失败：{e}")


# ─── 主循环 ────────────────────────────────────────────────

def main():
    if not HAS_LIBCST:
        # 启动时立刻报告 libcst 不可用
        error_response = {
            "id": "init",
            "success": False,
            "reason": "libcst 未安装，请运行：pip install libcst",
        }
        sys.stdout.write(json.dumps(error_response) + "\n")
        sys.stdout.flush()
        sys.exit(1)

    # 逐行读取 JSON 请求
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            response = {"id": "unknown", "success": False, "reason": f"JSON 解析失败：{e}"}
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue

        response = dispatch(request)
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

        # shutdown 请求：写完响应后退出
        if response.get("shutdown"):
            break


if __name__ == "__main__":
    main()
