package com.astworker;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.expr.SimpleName;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Java AST Worker — 通过 stdin/stdout JSON 协议与 VS Code 插件通信。
 *
 * 依赖：javaparser-core
 * 协议与 Python/C# worker 一致。
 */
public class JavaAstWorker {

    private static final Gson gson = new Gson();

    public static void main(String[] args) throws Exception {
        BufferedReader reader = new BufferedReader(
            new InputStreamReader(System.in, StandardCharsets.UTF_8)
        );

        String line;
        while ((line = reader.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;

            JsonObject request;
            try {
                request = gson.fromJson(line, JsonObject.class);
            } catch (Exception e) {
                writeResponse(failResponse("unknown", "JSON 解析失败：" + e.getMessage()));
                continue;
            }

            JsonObject response = dispatch(request);
            writeResponse(response);

            // shutdown 退出
            if ("shutdown".equals(getStr(request, "action"))) break;
        }
    }

    // ─── 分发器 ────────────────────────────────────────────

    private static JsonObject dispatch(JsonObject request) {
        String reqId = getStr(request, "id", "unknown");
        String action = getStr(request, "action", "");

        if ("ping".equals(action)) {
            JsonObject resp = new JsonObject();
            resp.addProperty("id", reqId);
            resp.addProperty("success", true);
            resp.addProperty("pong", true);
            return resp;
        }
        if ("shutdown".equals(action)) {
            JsonObject resp = new JsonObject();
            resp.addProperty("id", reqId);
            resp.addProperty("success", true);
            resp.addProperty("shutdown", true);
            return resp;
        }

        String filePath = getStr(request, "filePath", "");
        String fileContent = getStr(request, "fileContent", "");
        JsonObject params = request.has("params") ? request.getAsJsonObject("params") : new JsonObject();

        CompilationUnit cu;
        try {
            cu = StaticJavaParser.parse(fileContent);
        } catch (Exception e) {
            return failResponse(reqId, "Java 源码解析失败：" + e.getMessage());
        }

        try {
            switch (action) {
                case "add_import":
                    addImport(cu, params);
                    break;
                case "remove_import":
                    removeImport(cu, params);
                    break;
                case "insert_function":
                    insertFunction(cu, params);
                    break;
                case "edit_function_body":
                    editFunctionBody(cu, params);
                    break;
                case "add_function_param":
                    addFunctionParam(cu, params);
                    break;
                case "add_class_member":
                    addClassMember(cu, params);
                    break;
                case "rename_symbol":
                    renameSymbol(cu, params);
                    break;
                default:
                    return failResponse(reqId, "不支持的操作类型：" + action);
            }

            return successResponse(reqId, filePath, cu.toString());
        } catch (Exception e) {
            return failResponse(reqId, action + " 操作失败：" + e.getMessage());
        }
    }

    // ─── AST 操作 ──────────────────────────────────────────

    private static void addImport(CompilationUnit cu, JsonObject p) {
        String modulePath = getStr(p, "modulePath", "");
        if (modulePath.isEmpty()) throw new IllegalArgumentException("缺少 modulePath 参数");

        // 检查是否已存在
        boolean exists = cu.getImports().stream()
            .anyMatch(imp -> imp.getNameAsString().equals(modulePath));
        if (!exists) {
            cu.addImport(modulePath);
        }
    }

    private static void removeImport(CompilationUnit cu, JsonObject p) {
        String modulePath = getStr(p, "modulePath", "");
        if (modulePath.isEmpty()) throw new IllegalArgumentException("缺少 modulePath 参数");

        Optional<ImportDeclaration> toRemove = cu.getImports().stream()
            .filter(imp -> imp.getNameAsString().equals(modulePath))
            .findFirst();

        if (toRemove.isEmpty()) {
            throw new IllegalStateException("未找到 import " + modulePath);
        }
        toRemove.get().remove();
    }

    private static void insertFunction(CompilationUnit cu, JsonObject p) {
        String functionCode = getStr(p, "functionCode", "");
        String className = getStr(p, "className", "");
        String insertAfter = getStr(p, "insertAfter", "");

        if (functionCode.isEmpty()) throw new IllegalArgumentException("缺少 functionCode 参数");

        // 解析方法代码：包在临时 class 中以便 javaparser 解析
        String wrapperCode = "class _Temp { " + functionCode + " }";
        CompilationUnit tempCu = StaticJavaParser.parse(wrapperCode);
        MethodDeclaration newMethod = tempCu.findFirst(MethodDeclaration.class)
            .orElseThrow(() -> new IllegalArgumentException("无法解析方法代码"));

        ClassOrInterfaceDeclaration targetClass;
        if (!className.isEmpty()) {
            targetClass = findClass(cu, className);
        } else {
            targetClass = cu.findFirst(ClassOrInterfaceDeclaration.class)
                .orElseThrow(() -> new IllegalStateException("未找到任何 class 定义"));
        }

        if (!insertAfter.isEmpty()) {
            List<MethodDeclaration> methods = targetClass.getMethods();
            for (int i = 0; i < methods.size(); i++) {
                if (methods.get(i).getNameAsString().equals(insertAfter)) {
                    // 在锚点方法之后插入
                    targetClass.getMembers().add(targetClass.getMembers().indexOf(methods.get(i)) + 1, newMethod);
                    return;
                }
            }
        }
        targetClass.addMember(newMethod);
    }

    private static void editFunctionBody(CompilationUnit cu, JsonObject p) {
        String functionName = getStr(p, "functionName", "");
        String newBody = getStr(p, "newBody", "");

        MethodDeclaration method = findMethod(cu, functionName);
        BlockStmt newBlock = StaticJavaParser.parseBlock("{" + newBody + "}");
        method.setBody(newBlock);
    }

    private static void addFunctionParam(CompilationUnit cu, JsonObject p) {
        String functionName = getStr(p, "functionName", "");
        String paramCode = getStr(p, "paramCode", "");

        MethodDeclaration method = findMethod(cu, functionName);

        // 解析参数：包在临时方法中
        String wrapperCode = "class _T { void _m(" + paramCode + ") {} }";
        CompilationUnit tempCu = StaticJavaParser.parse(wrapperCode);
        Parameter newParam = tempCu.findFirst(Parameter.class)
            .orElseThrow(() -> new IllegalArgumentException("无法解析参数代码"));

        method.addParameter(newParam);
    }

    private static void addClassMember(CompilationUnit cu, JsonObject p) {
        String className = getStr(p, "className", "");
        String memberCode = getStr(p, "memberCode", "");
        String insertAfter = getStr(p, "insertAfter", "");

        if (className.isEmpty()) throw new IllegalArgumentException("缺少 className 参数");
        if (memberCode.isEmpty()) throw new IllegalArgumentException("缺少 memberCode 参数");

        ClassOrInterfaceDeclaration targetClass = findClass(cu, className);

        // 解析成员代码
        String wrapperCode = "class _Temp { " + memberCode + " }";
        CompilationUnit tempCu = StaticJavaParser.parse(wrapperCode);
        ClassOrInterfaceDeclaration tempClass = tempCu.findFirst(ClassOrInterfaceDeclaration.class)
            .orElseThrow();

        // 获取所有解析出的成员
        var newMembers = new ArrayList<>(tempClass.getMembers());

        if (!insertAfter.isEmpty()) {
            List<MethodDeclaration> methods = targetClass.getMethods();
            for (int i = 0; i < methods.size(); i++) {
                if (methods.get(i).getNameAsString().equals(insertAfter)) {
                    int insertIdx = targetClass.getMembers().indexOf(methods.get(i)) + 1;
                    for (int j = 0; j < newMembers.size(); j++) {
                        targetClass.getMembers().add(insertIdx + j, newMembers.get(j));
                    }
                    return;
                }
            }
        }

        for (var member : newMembers) {
            targetClass.addMember(member);
        }
    }

    private static void renameSymbol(CompilationUnit cu, JsonObject p) {
        String oldName = getStr(p, "oldName", "");
        String newName = getStr(p, "newName", "");

        if (oldName.isEmpty()) throw new IllegalArgumentException("缺少 oldName 参数");

        // 简单的单文件标识符重命名
        List<SimpleName> names = cu.findAll(SimpleName.class);
        int count = 0;
        for (SimpleName name : names) {
            if (name.getIdentifier().equals(oldName)) {
                name.setIdentifier(newName);
                count++;
            }
        }

        if (count == 0) {
            throw new IllegalStateException("未找到符号 " + oldName);
        }
    }

    // ─── 辅助函数 ──────────────────────────────────────────

    private static ClassOrInterfaceDeclaration findClass(CompilationUnit cu, String className) {
        return cu.findAll(ClassOrInterfaceDeclaration.class).stream()
            .filter(c -> c.getNameAsString().equals(className))
            .findFirst()
            .orElseThrow(() -> new IllegalStateException("未找到类 " + className));
    }

    private static MethodDeclaration findMethod(CompilationUnit cu, String methodName) {
        return cu.findAll(MethodDeclaration.class).stream()
            .filter(m -> m.getNameAsString().equals(methodName))
            .findFirst()
            .orElseThrow(() -> new IllegalStateException("未找到方法 " + methodName));
    }

    private static String getStr(JsonObject obj, String key) {
        return getStr(obj, key, "");
    }

    private static String getStr(JsonObject obj, String key, String defaultVal) {
        JsonElement el = obj.get(key);
        return el != null && !el.isJsonNull() ? el.getAsString() : defaultVal;
    }

    private static JsonObject failResponse(String id, String reason) {
        JsonObject resp = new JsonObject();
        resp.addProperty("id", id);
        resp.addProperty("success", false);
        resp.addProperty("reason", reason);
        return resp;
    }

    private static JsonObject successResponse(String id, String filePath, String newContent) {
        JsonObject resp = new JsonObject();
        resp.addProperty("id", id);
        resp.addProperty("success", true);

        JsonObject file = new JsonObject();
        file.addProperty("filePath", filePath);
        file.addProperty("newContent", newContent);

        com.google.gson.JsonArray files = new com.google.gson.JsonArray();
        files.add(file);
        resp.add("files", files);
        return resp;
    }

    private static void writeResponse(JsonObject response) {
        System.out.println(gson.toJson(response));
        System.out.flush();
    }
}
