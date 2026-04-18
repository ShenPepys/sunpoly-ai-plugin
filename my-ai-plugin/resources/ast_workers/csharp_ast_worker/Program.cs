/**
 * C# AST Worker — 通过 stdin/stdout JSON 协议与 VS Code 插件通信。
 *
 * 依赖：Microsoft.CodeAnalysis.CSharp (Roslyn)
 * 协议与 Python worker 一致：
 *   请求（stdin，每行一个 JSON）：
 *     { "id": "req-1", "action": "add_import", "filePath": "...", "fileContent": "...", "params": {...} }
 *   响应（stdout，每行一个 JSON）：
 *     成功：{ "id": "req-1", "success": true, "files": [{ "filePath": "...", "newContent": "..." }] }
 *     失败：{ "id": "req-1", "success": false, "reason": "错误原因" }
 */
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

var jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

// 逐行读取 JSON 请求
string? line;
while ((line = Console.ReadLine()) != null)
{
    line = line.Trim();
    if (string.IsNullOrEmpty(line)) continue;

    JsonNode? request;
    try
    {
        request = JsonNode.Parse(line);
    }
    catch (Exception ex)
    {
        WriteResponse(new { id = "unknown", success = false, reason = $"JSON 解析失败：{ex.Message}" });
        continue;
    }

    if (request == null)
    {
        WriteResponse(new { id = "unknown", success = false, reason = "空请求" });
        continue;
    }

    var response = Dispatch(request);
    WriteResponse(response);

    // shutdown 退出
    if (request["action"]?.GetValue<string>() == "shutdown") break;
}

// ─── 分发器 ────────────────────────────────────────────────

object Dispatch(JsonNode request)
{
    var reqId = request["id"]?.GetValue<string>() ?? "unknown";
    var action = request["action"]?.GetValue<string>() ?? "";

    if (action == "ping")
        return new { id = reqId, success = true, pong = true };
    if (action == "shutdown")
        return new { id = reqId, success = true, shutdown = true };

    var filePath = request["filePath"]?.GetValue<string>() ?? "";
    var fileContent = request["fileContent"]?.GetValue<string>() ?? "";
    var paramsNode = request["params"];

    SyntaxTree tree;
    try
    {
        tree = CSharpSyntaxTree.ParseText(fileContent);
    }
    catch (Exception ex)
    {
        return Fail(reqId, $"C# 源码解析失败：{ex.Message}");
    }

    var root = tree.GetCompilationUnitRoot();

    try
    {
        SyntaxNode newRoot = action switch
        {
            "add_import" => AddImport(root, paramsNode),
            "remove_import" => RemoveImport(root, paramsNode),
            "insert_function" => InsertFunction(root, paramsNode),
            "edit_function_body" => EditFunctionBody(root, paramsNode),
            "add_function_param" => AddFunctionParam(root, paramsNode),
            "add_class_member" => AddClassMember(root, paramsNode),
            "rename_symbol" => RenameSymbol(root, paramsNode),
            _ => throw new NotSupportedException($"不支持的操作类型：{action}")
        };

        var newContent = newRoot.NormalizeWhitespace().ToFullString();
        return Success(reqId, filePath, newContent);
    }
    catch (Exception ex)
    {
        return Fail(reqId, $"{action} 操作失败：{ex.Message}");
    }
}

// ─── AST 操作 ──────────────────────────────────────────────

SyntaxNode AddImport(CompilationUnitSyntax root, JsonNode? p)
{
    var modulePath = p?["modulePath"]?.GetValue<string>() ?? "";
    if (string.IsNullOrEmpty(modulePath))
        throw new ArgumentException("缺少 modulePath 参数");

    // 检查是否已有该 using
    var existing = root.Usings.FirstOrDefault(u => u.Name?.ToString() == modulePath);
    if (existing != null)
        return root; // 已存在，无需添加

    var usingDirective = SyntaxFactory.UsingDirective(SyntaxFactory.ParseName(modulePath))
        .NormalizeWhitespace()
        .WithTrailingTrivia(SyntaxFactory.CarriageReturnLineFeed);

    return root.AddUsings(usingDirective);
}

SyntaxNode RemoveImport(CompilationUnitSyntax root, JsonNode? p)
{
    var modulePath = p?["modulePath"]?.GetValue<string>() ?? "";
    if (string.IsNullOrEmpty(modulePath))
        throw new ArgumentException("缺少 modulePath 参数");

    var toRemove = root.Usings.Where(u => u.Name?.ToString() == modulePath).ToArray();
    if (toRemove.Length == 0)
        throw new InvalidOperationException($"未找到 using {modulePath}");

    return root.RemoveNodes(toRemove, SyntaxRemoveOptions.KeepNoTrivia)!;
}

SyntaxNode InsertFunction(CompilationUnitSyntax root, JsonNode? p)
{
    var functionCode = p?["functionCode"]?.GetValue<string>() ?? "";
    var className = p?["className"]?.GetValue<string>();
    var insertAfter = p?["insertAfter"]?.GetValue<string>();

    if (string.IsNullOrEmpty(functionCode))
        throw new ArgumentException("缺少 functionCode 参数");

    var newMember = SyntaxFactory.ParseMemberDeclaration(functionCode)
        ?? throw new ArgumentException("无法解析方法代码");

    if (!string.IsNullOrEmpty(className))
    {
        var classDecl = FindClass(root, className);
        if (insertAfter != null)
        {
            var anchor = classDecl.Members.OfType<MethodDeclarationSyntax>()
                .FirstOrDefault(m => m.Identifier.Text == insertAfter);
            if (anchor != null)
            {
                var idx = classDecl.Members.IndexOf(anchor);
                var newMembers = classDecl.Members.Insert(idx + 1, newMember);
                return root.ReplaceNode(classDecl, classDecl.WithMembers(newMembers));
            }
        }
        return root.ReplaceNode(classDecl, classDecl.AddMembers(newMember));
    }

    // 没指定 class，尝试加到第一个 class
    var firstClass = root.DescendantNodes().OfType<ClassDeclarationSyntax>().FirstOrDefault()
        ?? throw new InvalidOperationException("未找到任何 class 定义");
    return root.ReplaceNode(firstClass, firstClass.AddMembers(newMember));
}

SyntaxNode EditFunctionBody(CompilationUnitSyntax root, JsonNode? p)
{
    var functionName = p?["functionName"]?.GetValue<string>() ?? "";
    var newBody = p?["newBody"]?.GetValue<string>() ?? "";

    var method = root.DescendantNodes().OfType<MethodDeclarationSyntax>()
        .FirstOrDefault(m => m.Identifier.Text == functionName)
        ?? throw new InvalidOperationException($"未找到方法 {functionName}");

    var newBodyBlock = SyntaxFactory.ParseStatement($"{{{newBody}}}") as BlockSyntax
        ?? SyntaxFactory.Block(SyntaxFactory.ParseStatement(newBody));

    return root.ReplaceNode(method, method.WithBody(newBodyBlock));
}

SyntaxNode AddFunctionParam(CompilationUnitSyntax root, JsonNode? p)
{
    var functionName = p?["functionName"]?.GetValue<string>() ?? "";
    var paramCode = p?["paramCode"]?.GetValue<string>() ?? "";

    var method = root.DescendantNodes().OfType<MethodDeclarationSyntax>()
        .FirstOrDefault(m => m.Identifier.Text == functionName)
        ?? throw new InvalidOperationException($"未找到方法 {functionName}");

    var newParam = SyntaxFactory.ParseParameterList($"({paramCode})").Parameters[0];
    var newParams = method.ParameterList.AddParameters(newParam);
    return root.ReplaceNode(method, method.WithParameterList(newParams));
}

SyntaxNode AddClassMember(CompilationUnitSyntax root, JsonNode? p)
{
    var className = p?["className"]?.GetValue<string>() ?? "";
    var memberCode = p?["memberCode"]?.GetValue<string>() ?? "";
    var insertAfter = p?["insertAfter"]?.GetValue<string>();

    var classDecl = FindClass(root, className);
    var newMember = SyntaxFactory.ParseMemberDeclaration(memberCode)
        ?? throw new ArgumentException("无法解析成员代码");

    if (insertAfter != null)
    {
        var anchor = classDecl.Members.OfType<MethodDeclarationSyntax>()
            .FirstOrDefault(m => m.Identifier.Text == insertAfter);
        if (anchor != null)
        {
            var idx = classDecl.Members.IndexOf(anchor);
            var newMembers = classDecl.Members.Insert(idx + 1, newMember);
            return root.ReplaceNode(classDecl, classDecl.WithMembers(newMembers));
        }
    }

    return root.ReplaceNode(classDecl, classDecl.AddMembers(newMember));
}

SyntaxNode RenameSymbol(CompilationUnitSyntax root, JsonNode? p)
{
    var oldName = p?["oldName"]?.GetValue<string>() ?? "";
    var newName = p?["newName"]?.GetValue<string>() ?? "";

    // 简单的标识符文本替换（单文件级）
    var identifiers = root.DescendantTokens()
        .Where(t => t.IsKind(SyntaxKind.IdentifierToken) && t.Text == oldName)
        .ToList();

    if (identifiers.Count == 0)
        throw new InvalidOperationException($"未找到符号 {oldName}");

    SyntaxNode result = root;
    // 从后往前替换以保持位置正确
    foreach (var token in identifiers.OrderByDescending(t => t.SpanStart))
    {
        var newToken = SyntaxFactory.Identifier(token.LeadingTrivia, newName, token.TrailingTrivia);
        result = result.ReplaceToken(
            result.FindToken(token.SpanStart),
            newToken
        );
    }
    return result;
}

// ─── 辅助函数 ──────────────────────────────────────────────

ClassDeclarationSyntax FindClass(CompilationUnitSyntax root, string className)
{
    return root.DescendantNodes().OfType<ClassDeclarationSyntax>()
        .FirstOrDefault(c => c.Identifier.Text == className)
        ?? throw new InvalidOperationException($"未找到类 {className}");
}

object Fail(string id, string reason) => new { id, success = false, reason };

object Success(string id, string filePath, string newContent) =>
    new { id, success = true, files = new[] { new { filePath, newContent } } };

void WriteResponse(object response)
{
    var json = JsonSerializer.Serialize(response, new JsonSerializerOptions { WriteIndented = false });
    Console.WriteLine(json);
    Console.Out.Flush();
}
