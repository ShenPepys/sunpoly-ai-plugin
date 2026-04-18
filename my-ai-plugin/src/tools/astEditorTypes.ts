export type AstEditAction =
  | 'add_import'
  | 'remove_import'
  | 'insert_function'
  | 'edit_function_body'
  | 'add_function_param'
  | 'add_object_property'
  | 'add_class_member'
  | 'rename_symbol';

export type AstObjectLocator = {
  variableName?: string;
  functionName?: string;
  paramIndex?: number;
  propertyPath?: string[];
};

export type AstAddImportParams = {
  modulePath: string;
  namedImports?: string[];
  defaultImport?: string;
};

export type AstRemoveImportParams = {
  modulePath: string;
  namedImports?: string[];
};

export type AstInsertFunctionParams = {
  functionCode: string;
  insertAfter?: string;
  insertBefore?: string;
};

export type AstEditFunctionBodyParams = {
  functionName: string;
  newBody: string;
};

export type AstAddFunctionParamParams = {
  functionName: string;
  paramCode: string;
  position?: number;
};

export type AstAddObjectPropertyParams = {
  objectLocator: AstObjectLocator;
  propertyCode: string;
};

export type AstAddClassMemberParams = {
  className: string;
  memberCode: string;
  insertAfter?: string;
};

export type AstRenameSymbolParams = {
  oldName: string;
  newName: string;
  line?: number;
  column?: number;
};

export type AstEditParamsByAction = {
  add_import: AstAddImportParams;
  remove_import: AstRemoveImportParams;
  insert_function: AstInsertFunctionParams;
  edit_function_body: AstEditFunctionBodyParams;
  add_function_param: AstAddFunctionParamParams;
  add_object_property: AstAddObjectPropertyParams;
  add_class_member: AstAddClassMemberParams;
  rename_symbol: AstRenameSymbolParams;
};

export type AstEditRequest = {
  [TAction in AstEditAction]: {
    workspaceRoot: string;
    filePath: string;
    action: TAction;
    params: AstEditParamsByAction[TAction];
  };
}[AstEditAction];

export type AstEditedFile = {
  filePath: string;
  newContent: string;
};

export type AstEditSuccessResult = {
  success: true;
  files: AstEditedFile[];
};

export type AstEditFailureResult = {
  success: false;
  reason: string;
};

export type AstEditResult = AstEditSuccessResult | AstEditFailureResult;

export type AstRouteUnsupportedResult = {
  supported: false;
};

export type AstRouteResult = AstEditResult | AstRouteUnsupportedResult;

export interface AstLanguageAdapter {
  id: string;
  supportsFile(filePath: string): boolean;
  execute(request: AstEditRequest, fileContent: string): Promise<AstEditResult>;
  dispose?(): void;
}
