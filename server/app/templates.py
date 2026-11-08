"""Card-operation templates: file defaults + admin overrides stored in the DB."""
import copy
import json
import string

from .exports import PRORFL_EXPORTS

KINDS = ("i", "s", "o")
MAX_OUT = 4096


class TemplateError(ValueError):
    pass


def _fields(value):
    """Placeholder names used in a format string; reject anything but plain names."""
    names = []
    for _, field, _, _ in string.Formatter().parse(value):
        if field is None:
            continue
        if not field.isidentifier():
            raise TemplateError("placeholder {%s} must be a plain name" % field)
        names.append(field)
    return names


def validate(name, body):
    if not isinstance(body, dict):
        raise TemplateError("template must be an object")
    fn = body.get("fn")
    if fn not in PRORFL_EXPORTS:
        raise TemplateError("fn %r is not a proRFL.dll export" % fn)
    args = body.get("args")
    if not isinstance(args, list) or len(args) > 32:
        raise TemplateError("args must be a list (max 32)")
    for a in args:
        if not (isinstance(a, list) and len(a) == 2 and a[0] in KINDS):
            raise TemplateError("each arg must be [kind, value] with kind in i/s/o: %r" % (a,))
        kind, val = a
        if kind == "o":
            if not isinstance(val, int) or not 1 <= val <= MAX_OUT:
                raise TemplateError("output size must be an int 1..%d" % MAX_OUT)
        elif isinstance(val, str):
            _fields(val)
        elif not isinstance(val, int):
            raise TemplateError("arg value must be int or string: %r" % (val,))
    if not isinstance(body.get("calibrated", False), bool):
        raise TemplateError("calibrated must be true/false")
    if not isinstance(body.get("defaults", {}), dict):
        raise TemplateError("defaults must be an object")
    return body


class TemplateStore:
    def __init__(self, path, db):
        with open(path) as f:
            raw = json.load(f)
        self._file = {k: validate(k, v) for k, v in raw.items() if not k.startswith("_")}
        self._db = db

    def all(self):
        merged = copy.deepcopy(self._file)
        merged.update(self._db.get_template_overrides())
        return merged

    def get(self, name):
        tpl = self.all().get(name)
        if tpl is None:
            raise KeyError(name)
        return tpl

    def update(self, name, patch, actor):
        current = self.all().get(name, {})
        body = dict(current)
        body.update(patch)
        validate(name, body)
        self._db.set_template_override(name, body, actor)
        return body

    def render(self, name, params):
        """Return (fn, descs, calibrated) with placeholders filled from params."""
        tpl = self.get(name)
        values = dict(tpl.get("defaults", {}))
        values.update(params)
        descs = []
        for kind, val in tpl["args"]:
            if isinstance(val, str):
                try:
                    val = val.format(**values)
                except KeyError as e:
                    raise TemplateError("template %r needs parameter %s" % (name, e))
                except (ValueError, TypeError) as e:
                    raise TemplateError("template %r: bad value for placeholder (%s)" % (name, e))
            if kind in ("i", "o"):
                try:
                    val = int(val)
                except (TypeError, ValueError):
                    raise TemplateError("template %r: %r is not an integer" % (name, val))
            descs.append([kind, val])
        return tpl["fn"], descs, bool(tpl.get("calibrated", False))
