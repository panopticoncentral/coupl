# Coupl language specification

**Edition:** Experimental language, compiler package 0.1.0

**Revision date:** 2026-09-30

**Status:** Specification of the language implemented in this repository.

## Contents

- [1. Scope](#1-scope)
- [2. Conventions and conformance](#2-conventions-and-conformance)
- [3. Terms and definitions](#3-terms-and-definitions)
- [4. General description](#4-general-description)
- [5. Lexical structure](#5-lexical-structure)
- [6. Compilation units and declarations](#6-compilation-units-and-declarations)
- [7. Values and output references](#7-values-and-output-references)
- [8. Node calls and argument binding](#8-node-calls-and-argument-binding)
- [9. Types and compatibility](#9-types-and-compatibility)
- [10. Dynamic choices and maps](#10-dynamic-choices-and-maps)
- [11. Node catalog contract](#11-node-catalog-contract)
- [12. Graph validation and emission](#12-graph-validation-and-emission)
- [13. Diagnostics](#13-diagnostics)
- [Appendix A. Syntactic grammar](#appendix-a-syntactic-grammar)
- [Appendix B. Complete example](#appendix-b-complete-example)
- [Appendix C. Implementation correspondence](#appendix-c-implementation-correspondence)

## 1. Scope

Coupl is a declarative language for describing a graph of ComfyUI node instances. A compilation consists of source text and a target node catalog. Its result is either an API graph with any warnings or diagnostics indicating failure.

This specification defines source syntax, declaration and reference resolution, argument binding, type compatibility, the supported catalog contract, and graph emission. It covers the current experimental language, including primitive literal declarations, raw strings, dynamic-choice maps, wildcard ports, and matching-type ports.

The specification does not define the execution of ComfyUI nodes, server-side custom validation, scheduling, caching, model loading, or editor layout. Successful compilation establishes compatibility with the supported catalog rules; it does not guarantee successful execution on a server. File handling, catalog retrieval, authentication, and command-line options are host facilities rather than language features.

There is no source-level language-version directive. The package version above identifies this edition's implementation context; it is not a promise that all experimental revisions with that package version have identical language behavior. Proposed extensions in design notes are outside this edition unless specified here.

## 2. Conventions and conformance

### 2.1 Normative and informative text

Clauses 1–13 and Appendix A are normative for this edition, except paragraphs explicitly marked **Example** or **Note**, which are informative. Appendices B and C are informative. “Shall” denotes a requirement; “may” denotes permission. A *compile-time error* shall prevent a successful compilation result. A warning shall not by itself prevent a result.

This document follows the numbered-clause, lexical-grammar, semantic-rule, and informative-example organization of the [C# language specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/readme). Coupl's language rules are defined here independently.

### 2.2 Grammar notation

The grammar uses EBNF:

| Notation | Meaning |
| --- | --- |
| `name = ... ;` | Production defining a nonterminal |
| `"text"` | Terminal token or character sequence |
| `a b` | Sequence |
| `a \| b` | Alternative |
| `[ a ]` | Optional occurrence |
| `{ a }` | Zero or more occurrences |
| `( a )` | Grouping |
| `(* ... *)` | Grammar comment |

Lexical productions operate on characters. Syntactic productions operate on tokens after discarded whitespace and comments have been removed. `NL` denotes a line-feed token and `EOF` denotes end of source. Grammar acceptance is necessary but not sufficient: semantic restrictions elsewhere in this document also apply.

### 2.3 Conformance boundary

For a source text and catalog satisfying this specification, a conforming implementation shall preserve the graph structure, node identities, literal values subject to the numeric rules, and input/output bindings specified here. JSON whitespace and object member order are not significant.

For invalid input, at least one applicable error shall be reported and no partial graph shall be returned as a successful result. Exhaustive diagnostics and their ordering are not required. Diagnostic message wording is not part of the language contract. Clause 13 records the diagnostic categories used by this edition's implementation.

## 3. Terms and definitions

| Term | Definition |
| --- | --- |
| Compilation unit | The complete source text supplied to one compilation |
| Node class | A registered class identified by an exact key in the catalog |
| Node instance, or node | A graph entity introduced by one declaration |
| Node name | The source identifier naming an instance and its emitted API ID |
| Input | A named argument destination described by a node class schema |
| Output port | An indexed result described by a node class schema |
| Output reference | A source value denoting one output port of a declared node |
| Catalog | An object mapping registered class names to node metadata |
| Literal | A string, number, or boolean value written directly in source |
| Dynamic choice | A catalog input whose literal selector activates conditional child inputs |
| Map | Source syntax grouping a dynamic selector and its child arguments |
| Matching-type template | A type constraint shared by designated ports of one node instance |
| Execution output node | A class instance whose catalog metadata has `output_node: true` |
| API graph | The emitted object mapping node IDs to `class_type` and `inputs` objects |

An execution output node and an output port are different concepts. A class may be an execution output node while declaring no output ports.

## 4. General description

A compilation unit contains named node declarations. Each declaration constructs one graph node. A call identifies a node class and supplies its inputs; it does not invoke the node during compilation.

**Example:** Given the catalog described in Appendix B:

```coupl
checkpoint = CheckpointLoaderSimple("example.safetensors")
positive = CLIPTextEncode("A small observatory", clip = checkpoint.CLIP)
```

The declarations introduce two nodes. The second node has a literal text input and a connection to output port 1 of `checkpoint`.

All declarations share one scope. References may precede declarations. Source order does not establish execution order. Graph dependencies shall be acyclic, and every declared node shall be validated and emitted, including nodes not connected to an execution output node.

Compilation conceptually performs lexical and syntactic analysis, declaration lowering, catalog lookup, argument binding and dynamic selection, reference and type checking, cycle checking, and emission. Implementations may combine these operations provided their observable results conform to this specification.

## 5. Lexical structure

### 5.1 Source characters and positions

Source text is a sequence of characters represented by a JavaScript string in the current compiler. Identifiers use the ASCII subset in §5.4. Strings may contain non-ASCII text. Names are compared exactly, without case folding or Unicode normalization.

Source positions use zero-based UTF-16 code-unit offsets and one-based line and column numbers. A line feed increments the line number and resets the column to 1. Other code units, including tabs and carriage returns, advance the column by one. A source span includes its start and excludes its end.

**Note:** The supplied command-line host decodes source files as UTF-8. Byte decoding is outside the core language interface.

### 5.2 Whitespace and line terminators

Outside strings and comments, U+0020 SPACE, U+0009 TAB, U+000D CARRIAGE RETURN, and U+FEFF are discarded between tokens. No other whitespace characters are recognized as whitespace in this edition.

U+000A LINE FEED produces `NL`. A CRLF sequence therefore produces one `NL`; a lone carriage return does not separate declarations. Blank lines are permitted before, between, and after declarations.

Newlines are significant. They are permitted inside calls and maps only at the positions shown in Appendix A: after an opening delimiter, after a named argument or map entry's `=`, after a value, and after a comma. There is no general newline suppression inside parentheses or brackets.

**Example:**

```coupl
positive = CLIPTextEncode(
  text =
    "A small observatory",
  clip = checkpoint.CLIP,
)
```

A newline between a declaration's name and `=`, between that `=` and its initializer, between a class name and `(`, or inside an output selector is a syntax error. A newline between an argument name and its `=` is also a syntax error.

### 5.3 Comments

A single-line comment begins with `//` outside a string and extends to, but does not consume, the next line feed or end of source. Comments are discarded. There are no block comments, documentation-comment tokens, or preprocessing directives.

### 5.4 Identifiers and names

```ebnf
identifier = identifier-start { identifier-part } ;
identifier-start = "A" | "B" | ... | "Z" | "a" | "b" | ... | "z" | "_" ;
identifier-part = identifier-start | digit ;
digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;
```

The ellipses in this lexical presentation denote the intervening ASCII letters. Identifiers are scanned maximally. Escaped identifiers and Unicode escapes within identifiers are not supported.

Node names shall be identifiers other than `true` and `false`. Class names, argument names, and map keys may be identifiers or ordinary quoted strings. Dot output selectors require identifiers; bracket name selectors require ordinary quoted strings. Raw strings cannot be used as names.

`true` and `false` are recognized as boolean literals in value position and are prohibited as node names. They may be used in other name positions, including class, argument, map-key, and dot-selector names. No other words are reserved by this edition. For example, `null` is an identifier, not a null literal.

Quoted names are decoded using the ordinary-string rules. Quoted and unquoted spellings of the same name denote the same name. Prototype-like names such as `constructor` and `__proto__` have no special language meaning.

### 5.5 Boolean literals

The boolean literals are `true` and `false`, in lowercase. Their values are the corresponding booleans. Strings such as `"true"` are not boolean literals.

### 5.6 Numeric literals

```ebnf
number = [ "-" ] integer-part [ fraction ] [ exponent ] ;
integer-part = "0" | nonzero-digit { digit } ;
nonzero-digit = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;
fraction = "." digit { digit } ;
exponent = ( "e" | "E" ) [ "+" | "-" ] digit { digit } ;
```

A number token consumes the longest prefix matching this production. A leading plus sign, digit separators, hexadecimal notation, and a missing integer or fractional part are not permitted. Thus `+1`, `.5`, `1.`, and `0x10` are not valid numeric values. `01` scans as adjacent number tokens and is not a single value.

The value is the IEEE 754 binary64 value produced by JavaScript numeric conversion of the token. It shall be finite. If the converted value is integral, it shall lie in the inclusive safe integer range −9,007,199,254,740,991 through 9,007,199,254,740,991. A nonzero decimal significand that converts to zero is an error. Subnormal values that remain nonzero are permitted.

Ordinary decimal-to-binary rounding is allowed. These rules do not promise arbitrary-precision decimal preservation, even when the rounded result is a safe integer. Negative zero is accepted; JSON serialization represents it as `0`.

For `INT` compatibility, integrality is additionally determined from the decimal spelling before binary rounding (§9.2). The minus sign is part of a numeric token, not a general unary operator.

### 5.7 Ordinary string literals

An ordinary string begins and ends with `"` and uses JSON string syntax. It may contain JSON escapes `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\u` followed by four hexadecimal digits. Its value is the decoded JSON string.

Unescaped control characters U+0000 through U+001F are invalid. A physical carriage return or line feed cannot occur within an ordinary string. Single quotes do not delimit strings. JSON escape decoding does not normalize Unicode or require surrogate pairs to be well formed.

**Example:** `"line one\nline two"` contains a line feed, while `"line one\\nline two"` contains a backslash followed by `n`.

### 5.8 Raw string literals

A raw string begins with three consecutive double quotes (`"""`). Raw-string recognition takes precedence over ordinary-string recognition. After the opening delimiter, the first run of at least three consecutive double quotes terminates the string. The scanner consumes three quotes plus up to two immediately following quotes from that run. The value is the consumed token with its first three and last three quotes removed.

Consequently, a closing run of three quotes contributes no quotes to the value; a run of four or five contributes one or two trailing quotes. Any further quotes remain to be tokenized separately. Six consecutive quotes form an empty raw string when read as an opening delimiter immediately followed by a closing delimiter.

All intervening content is literal, including physical line endings, indentation, backslashes, tabs, and `//`. No escaping, interpolation, indentation removal, or newline trimming occurs. Embedded CRLF sequences are preserved. A missing closing delimiter is a syntax error.

**Example:**

```coupl
prompt = """A small observatory.
  Warm light through the windows.
A sign reading "Welcome"."""
```

**Note:** To represent three consecutive quotes within a value, use an ordinary string with escaped quotes. Delimiter length is fixed; adding more opening quotes does not select a different delimiter length.

### 5.9 Punctuation

The punctuation tokens are `=`, `(`, `)`, `,`, `.`, `[`, `]`, `{`, and `}`. They serve the grammatical roles specified below; there are no arithmetic, comparison, logical, or assignment-expression operators. Semicolons and colons are not tokens.

## 6. Compilation units and declarations

### 6.1 Compilation units

A compilation unit consists of declarations separated by one or more `NL` tokens. The last declaration may end at `EOF` without a final newline. A unit with no declarations is syntactically valid but shall fail compilation.

There are no imports, namespaces, modules, nested scopes, statement blocks, functions, reusable subgraph definitions, or executable statements in this edition.

### 6.2 Declaration space

Every declaration introduces one node name into the compilation unit's declaration space. A name shall be declared exactly once. Reassignment and shadowing are not permitted. Names are in scope throughout the compilation unit, including before their declaration.

Node names and registered class names are resolved in separate spaces. In `Text = Text(...)`, the left occurrence declares a node; the right occurrence names a catalog class. A call target never resolves to a previously declared node.

### 6.3 Explicit node declarations

An explicit node declaration has the form:

```ebnf
node-declaration = node-name "=" name "(" argument-list ")" ;
```

The class name shall identify an own property of the supplied catalog. A missing class is a compile-time error. The class schema determines available inputs and outputs; there is no built-in catalog of mandatory node classes.

An empty argument list is syntactically valid. Whether it is semantically valid depends on the required inputs of the selected class.

### 6.4 Literal node declarations

A top-level boolean or string initializer is shorthand for an explicit node declaration:

| Initializer syntax | Generated class | Generated named argument |
| --- | --- | --- |
| `true` or `false` | `PrimitiveBoolean` | `value` |
| Ordinary string | `PrimitiveString` | `value` |
| Raw string | `PrimitiveStringMultiline` | `value` |

The declared node name and decoded literal value are preserved. The delimiter syntax, rather than the presence of a newline in the value, selects the string class. Generated classes and arguments shall undergo ordinary catalog lookup, binding, and validation. No schema or missing input is synthesized.

**Example:** `label = "hello"` is equivalent to `label = PrimitiveString(value = "hello")`. `label = "hello\nworld"` still constructs `PrimitiveString`.

These declarations create nodes, not substitutable constants. Referencing their outputs creates connections. In particular, a declared string node cannot substitute for a literal enum or dynamic-choice selector.

A quoted class name or boolean-spelled class name followed immediately in the token stream by `(` is parsed as a call target. For example, `x = "Vendor: Node"()` is an explicit call. Discarded whitespace may intervene, but `NL` may not. A raw string is always a value and cannot be a call target.

Numeric literal declarations, aliases such as `b = a`, and top-level map assignments are not supported. A named numeric node requires an explicit call to an available class such as `PrimitiveInt` or `PrimitiveFloat`.

## 7. Values and output references

### 7.1 Value forms

An argument or map-entry value is a literal, an output reference, or a map. These are the only value forms. Calls cannot be nested as values. There are no array literals, null literals, general object literals, parenthesized expressions, interpolation expressions, or computations.

Literal arguments remain inline literal values. Only top-level literal declarations undergo the primitive-node lowering of §6.4.

### 7.2 Bare references

A bare node identifier denotes output port 0 if and only if that node's catalog schema declares exactly one output. A node with no outputs cannot be referenced as a value. A node with multiple outputs requires an explicit selector even if only one port has a type compatible with the receiving input.

### 7.3 Explicit selectors

An output reference may select a port by index or name:

| Form | Meaning |
| --- | --- |
| `node[0]` | Output at zero-based index 0 |
| `node.OUTPUT` | Output with exact name `OUTPUT` |
| `node["output name"]` | Output with the decoded quoted name |

A numeric selector shall have the spelling `0` or a nonzero decimal digit followed by decimal digits, and shall satisfy §5.6. Signs, decimal points, and exponents are not allowed in selectors, even when the numeric value would be a nonnegative integer. The selected index shall be within the declared output array.

A named selector shall match exactly one output name. If no name matches, or more than one name matches, the reference is invalid. Duplicate output names in a catalog are allowed; their ports remain accessible by index. If `output_name` is absent, output type names supply the names (§11.3).

There is no chaining: `node.a.b` and `node[0][1]` are not output references. Dot notation does not navigate runtime objects. The referenced node must exist in the compilation unit.

## 8. Node calls and argument binding

### 8.1 Argument lists

Arguments are comma-separated. The final argument may be followed by a trailing comma. A named argument uses `name = value`; a positional argument contains only a value. A call may contain only positional arguments, only named arguments, or a positional prefix followed by named arguments. A positional argument following any named argument is an error.

Argument names are identifiers or ordinary quoted strings and are compared after decoding. Named arguments may appear in any order.

### 8.2 Positional binding

The positional sequence consists of the catalog's ordered required top-level inputs followed by its ordered optional top-level inputs. Hidden inputs and dynamic child inputs do not occupy positions.

The first positional argument binds position 0, the next binds position 1, and so on. Positions cannot be skipped. Named arguments do not alter earlier positional bindings. Excess positional arguments are errors.

The order shall come from usable `input_order` metadata (§11.4), never from object key enumeration, alphabetical sorting, or an execution method's parameter order. If no usable order exists, positional arguments are invalid; named arguments may still be used.

### 8.3 Named binding and uniqueness

A named argument binds its exact input name. The name shall be a visible top-level input or an active dynamic child input. Unknown, hidden, and inactive input names are errors.

An input shall be supplied at most once. This rule applies across positional arguments, named arguments, and flattened map entries. Repeated values are still duplicates; there is no last-value-wins rule.

**Example:** If `text` is the first input, `CLIPTextEncode("first", text = "second", clip = checkpoint.CLIP)` supplies it twice and is invalid.

### 8.4 Required, optional, and hidden inputs

Every required visible input shall be supplied, including active required dynamic children. A catalog default does not satisfy this requirement. Optional inputs may be omitted and are then absent from emitted JSON. Hidden inputs cannot be supplied through source arguments. The compiler does not insert defaults or hidden values.

## 9. Types and compatibility

### 9.1 Type categories

Input schemas describe fixed type names, enumerated choices, wildcard types, matching types, or dynamic choices. Output ports describe fixed, wildcard, or matching types. Types are supplied by the catalog; source programs do not declare type annotations.

Fixed names are case-sensitive. Apart from the primitive literal rules below, custom names such as `MODEL`, `IMAGE`, and `LATENT` are opaque. They have no inheritance or structural relationship.

### 9.2 Literals and fixed types

| Input type | Admissible literal |
| --- | --- |
| `INT` | Number with an integral decimal spelling and a safe integral converted value |
| `FLOAT` | Any number accepted by §5.6 |
| `STRING` | Ordinary or raw string |
| `BOOLEAN` | Boolean |
| Other fixed name | No literal; an output connection is required |

Decimal spelling is integral when its exact base-10 value, including exponent, has no fractional part. Thus `1`, `1.0`, and `10e-1` may satisfy `INT`; `1.00000000000000001` does not, even if binary64 conversion rounds it to 1.

For non-enum numeric literal inputs, advertised `min` and `max` bounds are inclusive and apply to the converted number. Omitted bounds impose no restriction. Bounds are not statically evaluated against values carried by connections. Widget steps, suggested defaults, and display settings impose no additional language constraints.

### 9.3 Fixed connections

A connection between fixed ports is valid only when the output and input type names are equal. There is no implicit conversion from an `INT` output to a `FLOAT` input, although an integer literal can be supplied directly to a `FLOAT` input. Literal compatibility and connection compatibility are distinct rules.

### 9.4 Enumerated inputs

An enumerated input accepts only literals equal to one of its advertised primitive choices. Comparison does not coerce types: `1`, `"1"`, and `true` are distinct choices. An empty choice list accepts no literal. Numeric choice equality is based on the converted number; positive and negative zero compare equal.

Connections to enum inputs are unsupported, regardless of the connected output type or whether its runtime value could equal a choice. Enum membership is the complete literal check for such an input; numeric bounds do not impose an additional check on an accepted enum member in this edition.

### 9.5 Wildcards

A wildcard input (`*`) accepts any supported primitive literal or a valid output connection. A wildcard output may connect to any supported non-enum input type. A wildcard does not relax node existence, output selection, cycle, enum, or map restrictions.

Wildcard connections contribute no type evidence. They neither establish a concrete type nor erase constraints contributed by other ports. Acceptance through a wildcard does not prove runtime type compatibility.

### 9.6 Matching types

`COMFY_MATCHTYPE_V3` designates a port associated with a template. Template identity is scoped to one node instance. Instances of the same class have independent templates even if their template identifiers are spelled identically.

Each template has a candidate type set, initially its `allowed_types` set or unrestricted when that metadata is `*`. Constraints are applied as follows:

1. A connection to a fixed type intersects the candidate set with that type.
2. A connection between templates unifies their constraints by intersecting their candidate sets.
3. A string literal contributes `STRING`; a boolean literal contributes `BOOLEAN`.
4. A number with integral decimal spelling contributes the candidates `INT` and `FLOAT`; another number contributes `FLOAT`.
5. A wildcard connection contributes no restriction.

An empty intersection is a type error. Nonempty or unrestricted templates need not resolve to a single concrete type. Constraints propagate through the entire connected graph, including forward references and consumers of template-associated outputs.

All supplied inputs associated with a template participate. A literal switch condition does not exempt an unselected branch from checking. The compiler performs no runtime branch evaluation or branch pruning.

**Example:** A matching switch supplied with both `MODEL` and `STRING` outputs has inconsistent constraints. Two separate switches may independently carry `MODEL` and `STRING`.

## 10. Dynamic choices and maps

### 10.1 Selection and activation

A `COMFY_DYNAMICCOMBO_V3` input declares string option keys and grouped inputs for each option. Its selector shall be a literal equal to an option key. A reference to a string-producing node is not a literal selector.

Selecting an option activates its child inputs for that node instance. A child's emitted name is its parent input's full name, a dot, and the child's local name. Nested dynamic choices repeat this rule. An omitted optional selector activates no children; catalog defaults do not activate choices.

Active children follow the same required/optional, literal, connection, and type rules as top-level inputs. Child arguments shall be named; activation never adds positional argument slots. Supplying an inactive child is an error. Selection and binding do not depend on named-argument source order.

**Example:** Assume `Dynamic.mode` offers `on` with required `amount: FLOAT`, and `off` without children. Then:

```coupl
x = Dynamic(mode = "on", "mode.amount" = 0.7)
```

Changing the selector to `"off"` while retaining `"mode.amount"` is an error.

### 10.2 Map syntax

A map is a brace-delimited, comma-separated list of `name = value` entries. It may contain comments, permitted newlines, and a trailing comma. Keys are identifiers or ordinary strings. Duplicate decoded keys within the same map are errors.

A map is permitted semantically only for an active dynamic-choice input. It is not a runtime dictionary and cannot be supplied to an ordinary, wildcard, enum, or matching-type input. At most 32 maps may be nested, counting the outermost map as level 1.

### 10.3 Selector field and lowering

A map shall contain a selector field whose key is the dynamic input's **local schema name**. That field shall contain a literal option key. This remains required when the enclosing dynamic input is optional. The selector field may occur anywhere in the map.

The map lowers as follows:

1. Replace the map argument with its selector literal at the original input name.
2. For every other entry, concatenate the full input name, a dot, and the entry's key.
3. Require that resulting name to identify a direct child of the selected option.
4. Bind the entry's value to that child. Recursively lower maps on dynamic children.

**Example:** For the schema in §10.1:

```coupl
x = Dynamic(mode = { mode = "on", amount = 0.7 })
```

This has the same inputs as the dotted form in §10.1. It introduces no extra nodes and emits no JSON object as an input value.

For a nested input `outer.inner`, the map selector key is `inner`. A local schema name that itself contains a dot is preserved whole: an input locally named `a.b` requires selector key `"a.b"`. Quoted keys are exact names, not path expressions.

### 10.4 Mixing forms and collisions

Dotted arguments and maps may be combined when they supply distinct inputs. A dynamic input itself can be supplied positionally as a map if the top-level order is usable. A map occupies one positional argument slot.

Supplying the same flattened input more than once is an error, regardless of source order or value equality. Maps are not merged. A map key must name a direct child; a dotted key cannot skip over a nested choice merely by spelling a descendant's flattened path.

If a selected option declares a child with the same local name as the map's selector field, map syntax for that input is invalid even if that child would be omitted. The scalar selector plus dotted arguments can express that schema without ambiguity.

**Example:** With selector `mode` and child `mode`, use `mode = "on", "mode.mode" = "child"` instead of a map.

## 11. Node catalog contract

### 11.1 Catalog shape and validation scope

The catalog shall be a non-null, non-array object with at least one own enumerable key. Each class referenced by source, including a generated primitive class, shall be present as an own property. Unreferenced classes need not have usable metadata.

Referenced classes shall have a non-null, non-array `input` object and an `output` array. All declared visible schemas of a referenced class are validated, including inactive dynamic options and omitted optional inputs. Malformed supported metadata or an unsupported schema form is an error. Unrecognized auxiliary metadata does not add language semantics.

### 11.2 Input groups and schemas

Input group names may be `required`, `optional`, or `hidden`. Other group names are unsupported. Missing required or optional groups are treated as empty. Present required and optional groups shall be objects, and a visible input name shall not occur in both groups. Hidden group contents are excluded from visible input binding.

A visible input specification is an array of one or two elements: a type descriptor and, optionally, an options object. Supported descriptors are:

| Descriptor | Options used by this edition |
| --- | --- |
| Fixed type name or `*` | Optional numeric `min`, `max` |
| Array of primitive choices | Enum choices are the descriptor itself |
| `COMBO` | `options` array of primitive choices |
| `COMFY_DYNAMICCOMBO_V3` | `options` array of dynamic option objects |
| `COMFY_MATCHTYPE_V3` | `template` object |

Choice values shall be strings, booleans, or finite numbers; integral numeric choices shall be safe integers. `null`, arrays, and objects are not primitive choices.

Whenever a `min` or `max` option is present, it shall be a finite number. If both exist, `min` shall not exceed `max`. Malformed bounds invalidate a schema even where no supplied value would exercise them.

A fixed port descriptor shall be a nonempty string without commas or asterisks, except that the single string `*` denotes a wildcard. `COMBO` is not a fixed port type. Names beginning with `COMFY_` and ending with `_V3` are reserved schema markers; unsupported markers are rejected rather than treated as opaque types. Matching and dynamic markers have only the roles specified here.

**Note:** General union ports, autogrow schemas, dynamic-slot schemas, and arbitrary object-valued inputs are unsupported. Auxiliary fields such as list flags and custom validation hooks are not modeled by these rules.

### 11.3 Outputs

`output` shall contain supported fixed, wildcard, or matching-type descriptors. If `output_name` is supplied, it shall be an array of strings with the same length as `output`; otherwise the output descriptor strings are used as names. Duplicate names are allowed.

If present, `output_node` shall be boolean. Only the value `true` marks an execution output node. This flag is independent of the number of output ports.

### 11.4 Input order metadata

For each of the required and optional groups, usable `input_order` metadata shall provide an array naming every input in that group exactly once, with no extra names. An absent order array is acceptable for an empty group. A present order array for an empty group shall be empty.

If either group's order is unusable, the class has no usable positional order. This does not by itself invalidate the class schema. Named calls remain valid, subject to all other rules. Hidden order metadata is not part of the positional sequence.

### 11.5 Dynamic metadata

Each dynamic option shall be an object with a string `key` and an `inputs` object obeying the input-group rules. Option keys shall be unique within that selector. All option schemas are checked, including unselected options.

Dynamic schema expansion permits at most 32 nested option-input descents below the root input groups. This schema limit is separate from the source map nesting limit. Activating a child whose full flattened name collides with another active input is a schema error.

### 11.6 Matching metadata

A matching input's `template` shall contain a nonempty string `template_id` and string `allowed_types`. `allowed_types` is either `*` for unrestricted types or a comma-separated list of supported fixed type names. Whitespace in those names is not trimmed. Wildcard and matching markers cannot be members of a restricted list.

Repeated definitions of a template identifier within one class shall agree on allowed types. Authors should list restricted types once each; the implementation compares the list lengths and type membership when checking repeated definitions. Templates declared within conditional schemas are included in class template validation.

If present and non-null, `output_matchtypes` shall be an array with the same length as `output`. Each matching output shall have a string entry identifying a declared input template. A non-matching output shall have no template association (a missing or null entry). A matching output without a valid template association is a schema error.

## 12. Graph validation and emission

### 12.1 Dependencies and cycles

Each output reference creates a dependency from the receiving node to the referenced node. References inside maps participate in the same dependency graph. Self-dependencies and cycles of any length are compile-time errors, including cycles in components disconnected from execution output nodes.

There is no special starting declaration, pipeline statement, or source-defined entry point. A valid graph may have multiple independent components and multiple execution output nodes.

### 12.2 API graph representation

Successful compilation shall emit an object with one member per declaration. Its key is the exact declared node name. Each member has this structure:

```json
{
  "class_type": "RegisteredClassName",
  "inputs": {
    "literal_input": "literal value",
    "connected_input": ["source_node_name", 0]
  }
}
```

`class_type` is the decoded registered class name, including the generated class name for a literal declaration. `inputs` uses exact bound input names, including flattened dynamic names. Literals emit as JSON strings, numbers, or booleans. References emit as two-element arrays containing the source node ID and resolved output index.

No input defaults, hidden values, omitted optional inputs, type-template annotations, source spans, or map objects are added. There is no generated wrapper under a `prompt` property, no editor layout, and no node pruning. Source names remain stable API IDs when declarations are reordered or unrelated nodes are inserted.

### 12.3 Warnings and execution boundary

If no declared node has `output_node: true`, compilation succeeds with `W_NO_OUTPUT`, provided there are no errors. The warning identifies a graph fragment without an execution output node. The presence of an execution output node suppresses this warning; it does not prove that all other nodes are reachable from it or will execute.

The compiler produces graph data only. Submitting the graph to a server and observing its execution are outside compilation.

## 13. Diagnostics

Diagnostics have a severity, a code, a message, and a source span. They may include related spans, for example a first declaration or referenced node. Locations for generated primitive declarations refer to the original source. Catalog-wide and empty-source errors use the origin of the source.

The parser reports a lexical or syntactic failure without returning partial declarations. Semantic compilation may collect multiple errors. Warnings may accompany success, but an error result has no graph. The implementation is not required to diagnose later failures once an earlier error prevents meaningful checking.

| Code | Condition |
| --- | --- |
| `E_SYNTAX` | Invalid token or grammar, unsupported initializer, unterminated string, or excess map nesting |
| `E_NUMBER` | Numeric conversion violates representability limits |
| `E_ARGUMENT_ORDER` | Positional argument follows a named argument |
| `E_DUPLICATE_KEY` | A map repeats a decoded key |
| `E_CATALOG` | Catalog is not a nonempty object |
| `E_EMPTY` | Source contains no declarations |
| `E_DUPLICATE_NODE` | Node name is declared more than once |
| `E_NODE_CLASS` | Registered class is absent |
| `E_SCHEMA` | Unusable class metadata, unsupported enum connection, or nonliteral dynamic selector |
| `E_INPUT_ORDER` | Positional argument has no usable catalog order |
| `E_ARGUMENT_COUNT` | Too many positional arguments |
| `E_DUPLICATE_INPUT` | More than one argument supplies the same bound input |
| `E_INPUT` | Unknown, hidden, or inactive input or map child |
| `E_REQUIRED` | Required input or map selector field is missing |
| `E_MAP` | Map is used for an unsupported input or collides with a selector-named child |
| `E_REFERENCE` | Referenced node does not exist |
| `E_OUTPUT` | Invalid, missing, ambiguous, or non-unique implicit output selection |
| `E_ENUM` | Literal is not an advertised choice |
| `E_TYPE` | Literal, connection, or matching constraint is incompatible |
| `E_RANGE` | Numeric literal exceeds an advertised bound |
| `E_CYCLE` | Dependency graph contains a cycle |
| `W_NO_OUTPUT` | Valid graph has no execution output node |

## Appendix A. Syntactic grammar

This grammar is normative together with the lexical and semantic rules. `identifier`, `ordinary-string`, `raw-string`, and `number` are tokens defined in §5. Discarded whitespace and comments may occur between tokens. Only explicitly shown `NL` occurrences permit line breaks.

```ebnf
compilation-unit = { NL }
                   [ declaration { NL { NL } declaration } { NL } ]
                   EOF ;

declaration = node-name "=" initializer ;
node-name = identifier ;                 (* excludes true and false *)
initializer = node-call | boolean | ordinary-string | raw-string ;

node-call = name "(" argument-list ")" ;
name = identifier | ordinary-string ;

argument-list = { NL }
                [ argument { NL }
                  { "," { NL } argument { NL } }
                  [ "," { NL } ] ] ;
argument = named-argument | value ;
named-argument = name "=" { NL } value ;

value = boolean | number | ordinary-string | raw-string
      | output-reference | map ;
boolean = "true" | "false" ;

output-reference = node-name [ output-selector ] ;
output-selector = "." identifier
                | "[" output-index "]"
                | "[" ordinary-string "]" ;
output-index = number ;                  (* decimal digits only; see 7.3 *)

map = "{" { NL }
      [ map-entry { NL }
        { "," { NL } map-entry { NL } }
        [ "," { NL } ] ]
      "}" ;
map-entry = name "=" { NL } value ;
```

The following disambiguation and contextual rules accompany the grammar:

1. Raw-string scanning has priority over ordinary-string scanning.
2. At the start of an initializer, an ordinary string or boolean-spelled identifier followed by `(` denotes a class name in a call (§6.4).
3. At the start of an argument, a `name` followed by `=` begins a named argument. Otherwise the argument is a value.
4. In value position, `true` and `false` denote literals, not node references.
5. Positional arguments cannot follow named arguments (§8.1).
6. Duplicate map keys, map depth, numeric index spelling, and the semantic restrictions of clauses 6–12 still apply.

## Appendix B. Complete example

This appendix is informative. The following source uses the repository's synthetic [basic catalog fixture](../test/fixtures/catalog.mjs), which defines `CheckpointLoaderSimple` with outputs `MODEL`, `CLIP`, and `VAE` in that order, and `CLIPTextEncode` with inputs `text`, then `clip`:

```coupl
checkpoint = CheckpointLoaderSimple("example.safetensors")
positive = CLIPTextEncode("A small observatory", clip = checkpoint.CLIP)
```

The complete emitted graph is:

```json
{
  "checkpoint": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": {
      "ckpt_name": "example.safetensors"
    }
  },
  "positive": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "A small observatory",
      "clip": ["checkpoint", 1]
    }
  }
}
```

Compilation also produces `W_NO_OUTPUT`: this example describes a valid graph fragment. The fixture's checkpoint name is synthetic; acceptance by a live instance depends on that instance's catalog.

For larger examples, see [text-to-image.coupl](../examples/text-to-image.coupl), [blank-image.coupl](../examples/blank-image.coupl), and [krea-2-turbo.coupl](../examples/krea-2-turbo.coupl). Their execution prerequisites and validation status are described in the [README](../README.md).

## Appendix C. Implementation correspondence

This appendix is informative and records the implementation sources checked for this edition. It is intended to make future specification updates traceable.

| Specification area | Implementation | Regression coverage |
| --- | --- | --- |
| Lexical rules, syntax, positions | [parser.ts](../src/parser.ts) | [compiler](../test/compiler.test.mjs), [multiline strings](../test/multiline-strings.test.mjs) |
| Literal declarations | [compiler.ts](../src/compiler.ts) | [literal assignments](../test/literal-assignments.test.mjs) |
| Output selection | [compiler.ts](../src/compiler.ts) | [implicit outputs](../test/implicit-outputs.test.mjs), [compiler](../test/compiler.test.mjs) |
| Argument binding and maps | [binding.ts](../src/binding.ts) | [maps](../test/maps.test.mjs), [compiler](../test/compiler.test.mjs) |
| Catalog normalization and dynamic selection | [catalog.ts](../src/catalog.ts) | [advanced schemas](../test/advanced-schemas.test.mjs), [maps](../test/maps.test.mjs) |
| Matching constraints | [type-constraints.ts](../src/type-constraints.ts) | [advanced schemas](../test/advanced-schemas.test.mjs) |
| Literal checks, cycles, graph emission | [compiler.ts](../src/compiler.ts) | [compiler](../test/compiler.test.mjs), [advanced schemas](../test/advanced-schemas.test.mjs) |
| Result and diagnostic structure | [types.ts](../src/types.ts), [diagnostics.ts](../src/diagnostics.ts) | [compiler](../test/compiler.test.mjs) |

The [live validation record](live-validation.md) describes a particular server check, not a guarantee for other instances. Neither future design ideas nor historical test counts extend this edition's language rules.
