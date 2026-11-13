"""最小 JSON Schema 校验器：复现 Ajv 在工具参数上的核心职责。

对应 TS: src/tools/tool-contract.ts
- 支持 object/array/string/number/integer/boolean/null
- 支持 required/properties/additionalProperties/items/enum/const
- 支持 minLength/maxLength/minItems/maxItems/minimum/maximum
- 支持 anyOf/oneOf/allOf
- 不做类型强转、不填默认值、不删除多余字段
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ValidationIssue:
    path: str
    message: str
    hint: str = ""


def _escape_path(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _matches_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return True


def validate_schema(schema: dict[str, Any], value: Any, path: str = "") -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    location = path or "/"

    expected = schema.get("type")
    if isinstance(expected, str):
        if not _matches_type(value, expected):
            return [
                ValidationIssue(
                    location,
                    f"参数类型应为 {expected}，实际为 {_type_name(value)}",
                    "只修改该参数的类型，不要改其他字段。",
                )
            ]
    elif isinstance(expected, list):
        if not any(_matches_type(value, item) for item in expected):
            return [
                ValidationIssue(
                    location,
                    f"参数类型应为 {'/'.join(expected)}，实际为 {_type_name(value)}",
                    "只修改该参数的类型，不要改其他字段。",
                )
            ]

    if "const" in schema and value != schema["const"]:
        issues.append(ValidationIssue(location, f"参数必须等于 {schema['const']!r}"))

    if "enum" in schema and value not in schema["enum"]:
        issues.append(ValidationIssue(location, f"参数必须是 {schema['enum']} 之一"))

    if isinstance(value, dict):
        properties: dict[str, Any] = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                issues.append(
                    ValidationIssue(
                        f"{path}/{_escape_path(key)}",
                        f"缺少必填参数 {key}",
                        "补齐该参数后重试；不要传空对象或省略字段。",
                    )
                )
        for key, subschema in properties.items():
            if key in value:
                issues.extend(validate_schema(subschema, value[key], f"{path}/{_escape_path(key)}"))
        additional = schema.get("additionalProperties", True)
        if additional is False:
            for key in value:
                if key not in properties:
                    issues.append(
                        ValidationIssue(
                            f"{path}/{_escape_path(key)}",
                            f"不允许的参数 {key}",
                            "只使用 schema 中声明的参数名。",
                        )
                    )
        elif isinstance(additional, dict):
            for key in value:
                if key not in properties:
                    issues.extend(validate_schema(additional, value[key], f"{path}/{_escape_path(key)}"))

    if isinstance(value, list):
        min_items = schema.get("minItems")
        max_items = schema.get("maxItems")
        if isinstance(min_items, int) and len(value) < min_items:
            issues.append(ValidationIssue(location, f"数组至少需要 {min_items} 项"))
        if isinstance(max_items, int) and len(value) > max_items:
            issues.append(ValidationIssue(location, f"数组最多允许 {max_items} 项"))
        items = schema.get("items")
        if isinstance(items, dict):
            for index, item in enumerate(value):
                issues.extend(validate_schema(items, item, f"{path}/{index}"))

    if isinstance(value, str):
        min_length = schema.get("minLength")
        max_length = schema.get("maxLength")
        if isinstance(min_length, int) and len(value) < min_length:
            issues.append(ValidationIssue(location, f"字符串至少需要 {min_length} 个字符"))
        if isinstance(max_length, int) and len(value) > max_length:
            issues.append(ValidationIssue(location, f"字符串最多允许 {max_length} 个字符"))

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        if isinstance(minimum, (int, float)) and value < minimum:
            issues.append(ValidationIssue(location, f"数值不能小于 {minimum}"))
        if isinstance(maximum, (int, float)) and value > maximum:
            issues.append(ValidationIssue(location, f"数值不能大于 {maximum}"))

    for keyword in ("anyOf", "oneOf"):
        options = schema.get(keyword)
        if not isinstance(options, list):
            continue
        results = [validate_schema(option, value, path) for option in options]
        matched = sum(1 for result in results if not result)
        if keyword == "anyOf" and matched == 0:
            issues.append(ValidationIssue(location, "参数不满足任何允许的结构"))
        if keyword == "oneOf" and matched != 1:
            issues.append(ValidationIssue(location, f"参数必须恰好满足一种结构，实际满足 {matched} 种"))

    all_of = schema.get("allOf")
    if isinstance(all_of, list):
        for option in all_of:
            issues.extend(validate_schema(option, value, path))

    return issues
