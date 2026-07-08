Inline `code` và `code có <html> bên trong` và ``code có `backtick` bên trong`` và `` `bọc backtick` ``.

```javascript
function hello(name) {
  console.log(`Xin chào ${name}!`);
  return name * 2; // comment
}
```

```python
def hello(name: str) -> str:
    """Docstring."""
    return f"Xin chào {name}"
```

```
khối code không có ngôn ngữ
  giữ nguyên   khoảng trắng
```

```sql
SELECT id, name FROM users WHERE status = 'active';
```

Khối code thụt lề 4 space:

    indented code block
    dòng thứ hai

Fence chứa backtick:

````markdown
```js
nested fence
```
````
