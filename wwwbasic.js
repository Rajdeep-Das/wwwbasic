// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

(function() {
  function Interpret(code, real_canvas) {
    var canvas;
    if (real_canvas) {
      canvas= document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 1024;
    }

    var debugging_mode = typeof debug == 'boolean' && debug;
    // Parsing and Run State.
    var labels = {};
    var flow = [];
    var vars = {};
    var var_count = 0;
    var var_decls = '';
    var rstack = [];
    var ops = [];
    var curop = '';
    var ip = 0;

    // Input State
    var keys = [];
    var mouse_x = 0;
    var mouse_y = 0;
    var mouse_buttons = 0;
    var mouse_wheel = 0;
    var mouse_clip = 0;

    // Language Options
    var option_base = 0;
    var option_explicit = false;

    // Yield State
    var yielding = 0;
    var quitting = 0;
    var delay = 0;

    // Drawing and Console State
    var color = 0xffffff;
    var text_x = 0;
    var text_y = 1;
    var ctx;
    if (canvas) {
      ctx = canvas.getContext('2d');
      ctx.font = '14px monospace';
    }

    var toklist = [
      ':', ';', ',', '(', ')', '{', '}', '[', ']',
      '+=', '-=', '*=', '/=', '\\=', '^=', '&=',
      '+', '-', '*', '/', '\\','^', '&',
      '<=', '>=', '<>', '=', '<', '>', '@', '\n',
    ];
    if (canvas) {
      code = code.replace(/&lt;/g, '<');
      code = code.replace(/&gt;/g, '>');
      code = code.replace(/&amp;/g, '&');
    }

    var tok = null;
    var line = canvas ? 0 : 1;

    function Next() {
      tok = '';
      for (;;) {
        while (code.substr(0, 1) == ' '  ||
               code.substr(0, 1) == '\t') {
          if (tok != '') {
            return;
          }
          code = code.substr(1);
        }
        if (code.search(/^_[ \t]*('[^\n]*)?\n/) != -1) {
          if (tok != '') {
            return;
          }
          code = code.substr(code.search('\n') + 1);
          ++line;
          continue;
        }
        if (code.substr(0, 1) == '\'') {
          if (tok != '') {
            return;
          }
          while (code.length > 0 && code.substr(0, 1) != '\n') {
            code = code.substr(1);
          }
          continue;
        }
        if (code.substr(0, 1) == '"') {
          if (tok != '') {
            return;
          }
          tok = '"';
          code = code.substr(1);
          while (code.length > 0 && code.substr(0, 1) != '"') {
            tok += code.substr(0, 1);
            code = code.substr(1);
          }
          tok += '"';
          code = code.substr(1);
          return;
        }
        for (var i = 0; i < toklist.length; ++i) {
          if (code.substr(0, toklist[i].length) == toklist[i]) {
            if (tok != '') {
              if (code.substr(0, 1) == '&' &&
                code.substr(code.length-1) != '$') {
                tok += '&';
                code = code.substr(1);
              }
              return;
            }
            tok = toklist[i];
            code = code.substr(toklist[i].length);
            if (tok == '\n') {
              ++line;
              tok = '<EOL>';
            } else if (tok == '&' && code.substr(0, 1).toLowerCase() == 'h') {
              tok = '0x';
              code = code.substr(1);
              while (code.substr(0, 1).search(/[A-Fa-f0-9]/) != -1) {
                tok += code.substr(0, 1);
                code = code.substr(1);
              }
            }
            return;
          }
        }
        tok += code.substr(0, 1).toLowerCase();
        code = code.substr(1);
        if (code == '') {
          return;
        }
      }
    }
    Next();

    function Throw(msg) {
      throw msg + ' at line ' + line;
    }

    function Skip(t) {
      if (tok != t) {
        Throw('Expected "'+ t + '" found "' + tok + '"');
      }
      Next();
    }

    function NewOp() {
      ops.push(curop);
      curop = '';
    }

    function If(e, n) {
      if (n === undefined) {
        n = [];
      }
      NewOp();
      ops[ops.length - 1] += 'if (!(' + e + ')) { ip = ';
      flow.push(['if', ops.length - 1, []]);
    }

    function Else() {
      var f = flow.pop();
      if (f[0] != 'if') {
        Throw('ELSE unmatched to IF');
      }
      NewOp();
      var pos = ops.length - 1;
      ops[pos] += 'ip = ';
      NewOp();
      ops[f[1]] += ops.length + '; }\n';
      flow.push(['else', null, f[2].concat(pos)]);
    }

    function ElseIf(e) {
      var f = flow.pop();
      if (f[0] != 'if') {
        Throw('ELSEIF unmatched to IF');
      }
      NewOp();
      var pos = ops.length - 1;
      ops[pos] += 'ip = ';
      NewOp();
      ops[f[1]] += ops.length + '; }\n';
      ops[ops.length - 1] += 'if (!(' + e + ')) { ip = ';
      flow.push(['if', ops.length - 1, f[2].concat([pos])]);
    }

    function EndIf() {
      NewOp();
      var f = flow.pop();
      if (f[0] == 'else') {
        // nothing needed
      } else if (f[0] == 'if') {
        ops[f[1]] += ops.length + '; }\n';
      } else {
        Throw('Unmatch end if');
      }
      for (var i = 0; i < f[2].length; ++i) {
        ops[f[2][i]] += ops.length + ';\n';
      }
    }

    function Factor3() {
      if (tok == '(') {
        Skip('(');
        var ret = Expression();
        Skip(')');
        return ret;
      } else {
        var name = tok;
        Next();
        var v = vars[name];
        if (name == 'rnd') {
          Skip('(');
          if (tok != ')') {
            var e = Expression();
          }
          Skip(')');
          return 'Math.random()';
        }
        if (name == 'log' || name == 'ucase$' || name == 'lcase$' ||
            name == 'chr$' || name == 'sqr' || name == 'int' ||
            name == 'abs' ||
            name == 'cos' || name == 'sin' || name == 'tan' ||
            name == 'exp' || name == 'str$') {
          Skip('(');
          var e = Expression();
          Skip(')');
          switch (name) {
            case 'log': return 'Math.log(' + e + ')';
            case 'ucase$': return '(' + e + ').toUpperCase()';
            case 'lcase$': return '(' + e + ').toLowerCase()';
            case 'chr$': return 'String.fromCharCode(' + e + ')';
            case 'asc': return '(' + e + ').toCharCode(0)';
            case 'sqr': return 'Math.sqrt(' + e + ')';
            case 'int': return 'Math.floor(' + e + ')';
            case 'abs': return 'Math.abs(' + e + ')';
            case 'cos': return 'Math.cos(' + e + ')';
            case 'sin': return 'Math.sin(' + e + ')';
            case 'tan': return 'Math.tan(' + e + ')';
            case 'exp': return 'Math.exp(' + e + ')';
            case 'str$': return '(' + e + ').toString()';
          }
          Throw('This cannot happen');
        }
        if (name == 'atan2') {
          Skip('(');
          var a = Expression();
          Skip(',');
          var b = Expression();
          Skip(')');
          return 'Math.atan2(' + a + ', ' + b + ')';
        }
        if (name == 'inkey$') {
          return 'Inkey()';
        }
        if (name == 'timer') {
          return '(new Date().getTime() / 1000.0)';
        }
        if (v === undefined) {
          // TODO: Parse numbers.
          return name;
        }
        if (vars[name] != undefined) {
          return IndexVariable(name);
        } else {
          if (tok == '(') {
            Skip('(');
            var e = Expression();
            while (tok == ',') {
              Skip(',');
              var e = Expression();
            }
            Skip(')');
            return 'xxx' + v[0];
          } else {
            return v[0];
          }
        }
      }
    }

    function Factor2() {
      var a = Factor3();
      while (tok == '^') {
        Next();
        var b = Factor3();
        a = 'Math.pow(' + a + ', ' + b + ')';
      }
      return a;
    }

    function Factor1() {
      var ret = '';
      while (tok == '+' || tok == '-') {
        ret += tok;
        Next();
      }
      return ret + '(' + Factor2() + ')';
    }

    function Factor() {
      var a = Factor1();
      while (tok == '*' || tok == '/') {
        var op = tok;
        Next();
        var b = Factor1();
        a = '(' + a + ')' + op + '(' + b + ')';
      }
      return a;
    }

    function Term2() {
      var a = Factor();
      while (tok == '\\') {
        var b = Next();
        Factor();
        a = '(' + a + ')//(' + b + ')';
      }
      return a;
    }

    function Term1() {
      var a = Term2();
      while (tok == 'mod') {
        Next();
        var b = Term2();
        a = '((' + a + ')%(' + b + '))';
      }
      return a;
    }

    function Term() {
      var a = Term1();
      while (tok == '+' || tok == '-') {
        var op = tok;
        Next();
        var b = Term1();
        a = '(' + a + ')' + op + '(' + b + ')';
      }
      return a;
    }

    function Relational() {
      var a = Term();
      while (tok == '=' || tok == '<' || tok == '>' ||
             tok == '<>' || tok == '<=' || tok == '>=') {
        var op = tok;
        Next();
        var b = Term();
        if (op == '=') {
          a = '(' + a + ') == (' + b + ') ? -1 : 0';
        } else if (op == '<>') {
          a = '(' + a + ') != (' + b + ') ? -1 : 0';
        } else {
          a = '(' + a + ') ' + op + ' (' + b + ') ? -1 : 0';
        }
      }
      return a;
    }

    function Logical1() {
      var ret = '';
      while (tok == 'not') {
        Next();
        ret += '~';
      }
      return ret + '(' + Relational() + ')';
    }

    function Logical() {
      var a = Logical1();
      while (tok == 'and') {
        Next();
        var b = Logical1();
        a = '(' + a + ') & (' + b + ')';
      }
      return a;
    }

    function Expression() {
      var a = Logical();
      while (tok == 'or') {
        Next();
        var b = Logical();
        a = '(' + a + ') | (' + b + ')';
      }
      return a;
    }

    function TypeName() {
      if (tok == 'byte') {
        Skip('byte');
        return 'Uint8Array';
      } else if (tok == 'single') {
        Skip('single');
        return 'Float32Array';
      } else if (tok == 'double') {
        Skip('double');
        return 'Float64Array';
      } else if (tok == 'integer') {
        Skip('integer');
        return 'Int32Array';
      } else if (tok == 'string') {
        Skip('string');
        return 'Array';
      }
      Throw('Unexpected type "' + tok + '"');
    }

    var TypeMap = {
      'Uint8Array': 'b',
      'Int16Array': 'i16',
      'Int32Array': 'i',
      'Float32Array': 's',
      'Float64Array': 'd',
      'Array': 'str',
    };

    function ImplicitType(name) {
      if (name[name.length-1] == '$') {
        // TODO: String Array Init.
        return 'Array';
      } else if (name[name.length-1] == '%') {
        return 'Int16Array';
      } else if (name[name.length-1] == '&') {
        return 'Int32Array';
      } else if (name[name.length-1] == '!') {
        return 'Float32Array';
      } else if (name[name.length-1] == '#') {
        return 'Float64Array';
      } else {
        return 'Float32Array';
      }
    }

    function ImplicitDimVariable(name) {
      var vdef = [var_count++, ImplicitType(name)];
      vdef[0] = TypeMap[vdef[1]] + '[' + vdef[0] + ']';
      var_decls += '// ' + vdef[0] + ' is ' + name + '\n';
      vars[name] = vdef;
      return vdef;
    }

    function DimVariable(default_tname) {
      var name = tok;
      Next();
      // Pick default.
      if (default_tname === null) {
        default_tname = ImplicitType(name);
      }
      // name,  dims..
      var vdef = [var_count++, default_tname];
      var defaults = [];
      if (tok == '(') {
        Skip('(');
        var e = Expression();
        var d = 'dim' + var_count++;
        var_decls += 'const ' + d + ' = (' + e + ');\n';
        if (tok == 'to') {
          Skip('to');
          var e1 = Expression();
          var d1 = 'dim' + var_count++;
          var_decls += 'const ' + d1 + ' = (' + e1 + ');\n';
          vdef.push([d, d1]);
        } else {
          vdef.push([option_base, d]);
        }
        while (tok == ',') {
          Skip(',');
          var e = Expression();
          var d = 'dim' + var_count++;
          var_decls += 'const ' + d + ' = (' + e + ');\n';
          vdef.push([option_base, d]);
        }
        Skip(')');
        if (tok == '=') {
          Skip('=');
          Skip('{');
          var e = Expression();
          defaults.push(e);
          while (tok == ',') {
            Skip(',');
            var e = Expression();
            defaults.push(e);
          }
          Skip('}');
        }
      } else if (tok == '=') {
        Skip('=');
        var e = Expression();
        defaults.push(e);
      }
      if (tok == 'as') {
        Skip('as');
        vdef[1] = TypeName();
      }
      if (vars[name] !== undefined) {
        Throw('Variable ' + name + ' defined twice');
      }
      vars[name] = vdef;
      if (vdef.length > 2) {
        vdef[0] = 'a' + vdef[0];
        var_decls += 'var ' + vdef[0] + ';  // ' + name + '\n';
        var parts = [];
        for (var i = 2; i < vdef.length; i++) {
          parts.push('((' + vdef[i][1] + ')-(' + vdef[i][0] + ')+1)');
        }
        curop += 'if (' + vdef[0] + ' === undefined) {\n';
        curop += '  ' + vdef[0] + ' = new ' + vdef[1] +
          '(' + parts.join('*') + ');\n';
        if (defaults.length > 0) {
          for (var i = 0; i < defaults.length; i++) {
            curop += '  ' + vdef[0] + '[' + i + '] = (' + defaults[i] + ');\n';
          }
        }
        curop += '}\n';
      } else {
        vdef[0] = TypeMap[vdef[1]] + '[' + vdef[0] + ']';
        var_decls += '// ' + vdef[0] + ' is ' + name + '\n';
        if (defaults.length > 0) {
          curop += vdef[0] + ' = ' + defaults[0] + ';\n';
        }
      }
    }

    function IndexVariable(name) {
      var v = vars[name];
      if (v === undefined) {
        if (option_explicit) {
          Throw('Undeclared variable ' + name);
        } else {
          v = ImplicitDimVariable(name);
        }
      }
      var vname = v[0];
      if (tok == '(') {
        Skip('(');
        var dims = [];
        var e = Expression();
        dims.push(e);
        while (tok == ',') {
          Skip(',');
          var e = Expression();
          dims.push(e);
        }
        Skip(')');
        vname += '[';
        for (var i = 0; i < dims.length; ++i) {
          vname += '(((' + dims[i] + ')|0)-' + v[i + 2][0] + ')';
          for (var j = 0; j < i; ++j) {
            vname += '*(' + v[j + 2][1] + '-' + v[j + 2][0] + ' + 1)';
          }
          if (i != dims.length - 1) {
            vname += '+';
          }
        }
        vname += ']';
      }
      return vname;
    }

    function End() {
      yielding = 1;
      quitting = 1;
      if (canvas) {
        console.log('BASIC END');
      } else {
        if (output_buffer != '') {
          Put('\n');
        }
      }
    }

    function Sleep(t) {
      yielding = 1;
      delay = t;
    }

    function Inkey() {
      yielding = 1;
      if (keys.length > 0) {
        return keys.shift();
      } else {
        return '';
      }
    }

    function Yield() {
      yielding = 1;
    }

    function Screen(mode) {
      // TODO: Handle for real.
      console.log('screen ' + mode);
    }

    var output_buffer = '';

    function Put(ch) {
      if (canvas) {
        if (ch == '\n') {
          text_x = 0;
          text_y++;
          return;
        }
        WithColor(0);
        ctx.fillRect(text_x * 8, text_y * 16 - 16, 8, 16);
        WithColor();
        ctx.fillText(ch, text_x * 8, text_y * 16 - 3);
        text_x++;
        if (text_x > 160) {
          text_y++;
          text_x = 0;
        }
      } else {
        if (ch == '\n') {
          console.log(output_buffer);
          output_buffer = '';
        } else {
          output_buffer += ch;
        }
      }
    }

    function Print(items) {
      if (items.length == 0) {
        Put('\n');
        return;
      }
      for (var i = 0; i < items.length; i += 2) {
        var text;
        if (items[i] === undefined) {
          text = '';
        } else {
          text = items[i].toString();
        }
        for (var j = 0; j < text.length; j++) {
          Put(text[j]);
        }
        if (items[i+1] == ',') {
          Put(' ');
          Put(' ');
          Put(' ');
        }
        if (items[i+1] != ';' && items[i+1] != ',') {
          Put('\n');
        }
      }
    }

    function PrintUsing(format, items) {
      Print(items);
    }

    function WithColor(c) {
      if (c === undefined) {
        c = color;
      }
      c = c|0;
      var cc = '00000' + c.toString(16)
      ctx.strokeStyle = '#' + cc.substr(cc.length - 6);
      ctx.fillStyle = '#' + cc.substr(cc.length - 6);
    }

    function Color(c) {
      color = c;
    }

    function Locate(x, y) {
      text_x = x - 1;
      text_y = y;
    }

    function Line(x1, y1, x2, y2, c, fill) {
      ctx.lineWidth = 2;
      WithColor(c);
      if (fill == 0) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      } else if (fill >= 1) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x1, y2);
        ctx.lineTo(x1, y1);
        if (fill == 1) {
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
    }
    var last = 0;

    function Pset(x, y, c) {
      WithColor(c);
      ctx.fillRect(x, y, 1, 1);
    }

    function Circle(x, y, r, c, start, end, aspect, fill) {
      WithColor(c);
      ctx.beginPath();
      // TODO: aspect
      ctx.arc(x, y, r, start, end);
      if (fill) {
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }

    function GetVar(name) {
      if (vars[name] === undefined) {
        if (option_explicit) {
          Throw('Unknown variable ' + name);
        } else {
          ImplicitDimVariable(name);
        }
      }
      return vars[name];
    }

    function Statement() {
      if (tok == '<EOL>') {
        // Ignore empty lines.
      } else if (tok == 'if') {
        Skip('if');
        var e = Expression();
        Skip('then');
        if (tok == ':' || tok == '<EOL>') {
          If(e);
          while (tok == ':') {
            Skip(':');
            Statement();
          }
          if (tok == 'else') {
            Skip('else');
            Else();
            while (tok == ':') {
              Skip(':');
              Statement();
            }
          }
          if (tok == 'end') {
            Skip('end');
            Skip('if');
            EndIf();
          }
        } else {
          If(e);
          Statement();
          while (tok == ':') {
            Statement();
          }
          var f = flow.pop();
          if (f[0] != 'if') {
            Throw('If in mixed style');
          }
          flow.push(f);
          NewOp();
          EndIf();
        }
      } else if (tok == 'elseif') {
        Skip('elseif');
        var e = Expression();
        Skip('then');
        ElseIf(e);
      } else if (tok == 'else') {
        Skip('else');
        Else();
      } else if (tok == 'do') {
        Skip('do');
        NewOp();
        flow.push(['do', ops.length]);
      } else if (tok == 'loop') {
        Skip('loop');
        Skip('while');
        var e = Expression();
        var f = flow.pop();
        if (f[0] != 'do') {
          Throw('Loop does not match do');
        }
        curop += 'if (' + e + ') { ip = ' + f[1] + '; }\n';
      } else if (tok == 'while') {
        Skip('while');
        var e = Expression();
        NewOp();
        curop += 'if (!(' + e + ')) { ip = ';
        NewOp();
        flow.push(['while', ops.length-1]);
      } else if (tok == 'wend') {
        Skip('wend');
        var f = flow.pop();
        if (f[0] != 'while') {
          Throw('Wend does not match while');
        }
        curop += 'ip = ' + f[1] + ';\n';
        NewOp();
        ops[f[1]] += ops.length + '; }\n';
      } else if (tok == 'end') {
        Skip('end');
        if (tok == 'if') {
          Skip('if');
          EndIf();
        } else if (tok == 'select') {
          Skip('select');
          NewOp();
          var f = flow.pop();
          if (f[0] != 'select') {
            Throw('end select outside select');
          }
          var disp = 'var t = (' + f[1] + ');\n';
          disp += 'if (false) {}\n';
          for (var i = 0; i < f[3].length; i++) {
            var ii = f[3][i];
            if (ii[0] == ii[1]) {
              disp += 'else if (t == (' + ii[0] +
                      ')) { ip = ' + ii[2] + '; }\n';
            } else {
              disp += 'else if (t >= (' + ii[0] + ') && t <= (' + ii[1] +
                      ')) { ip = ' + ii[2] + '; }\n';
            }
          }
          if (f[5] !== null) {
            disp += 'else { ip = ' + f[5] + '; }\n';
          } else {
            disp += 'else { ip = ' + ops.length + '; }\n';
          }
          ops[f[2]] += disp;
          for (var i = 0; i < f[4].length; i++) {
            ops[f[4][i]] += 'ip = ' + ops.length + ';\n';
          }
        } else {
          curop += 'End();\n';
        }
      } else if (tok == 'goto') {
        Skip('goto');
        var name = tok;
        Next();
        curop += 'ip = labels["' + name + '"];\n';
        NewOp();
      } else if (tok == 'gosub') {
        Skip('gosub');
        var name = tok;
        Next();
        curop += 'rstack.push(ip);\n';
        curop += 'ip = labels["' + name + '"];\n';
        NewOp();
      } else if (tok == 'return') {
        Skip('return');
        curop += 'ip = rstack.pop();\n';
        NewOp();
      } else if (tok == 'const') {
        Skip('const');
        for (;;) {
          var name = tok;
          Next();
          var v = vars[name];
          if (v !== undefined) {
            Throw('Constant ' + name + ' defined twice');
          }
          vars[name] = ['c' + var_count++];
          v = vars[name];
          Skip('=');
          var value = Expression();
          var_decls += 'const ' + v[0] +
            ' = (' + value + ');  // ' + name + '\n';
          if (tok == ',') {
            Skip(',');
            continue;
          }
          break;
        }
      } else if (tok == 'dim') {
        Skip('dim');
        if (tok == 'shared') {
          Skip('shared');
        }
        var tname = null;
        if (tok == 'as') {
          Skip('as');
          tname = TypeName();
        }
        DimVariable(tname);
        while (tok == ',') {
          Skip(',');
          DimVariable(tname);
        }
      } else if (tok == 'option') {
        Skip('option');
        if (tok == 'explicit') {
          Skip('explicit');
          option_explicit = true;
        } else if (tok == 'base') {
          Skip('base');
          if (tok == '0') {
            option_base = 0;
          } if (tok == '1') {
            option_base = 1;
          } else {
            Throw('Unexpected option base "' + tok + '"');
          }
          Next();
        } else {
          Throw('Unexpected option "' + tok + '"');
        }
      } else if (tok == 'defdbl') {
        Skip('defdbl');
        var start = tok;
        Next();
        Skip('-');
        var end = tok;
        Next();
      } else if (tok == 'for') {
        Skip('for');
        var name = tok;
        var v = vars[name];
        if (v === undefined) {
          if (option_explicit) {
            Throw('Undeclared variable ' + name);
          } else {
            v = ImplicitDimVariable(name);
          }
        }
        Next();
        Skip('=');
        var start = Expression();
        Skip('to');
        var end = Expression();
        var step = 1;
        if (tok == 'step') {
          Skip('step');
          step = Expression();
        }
        curop += v[0] + ' = (' + start + ');';
        NewOp();
        curop += 'if (((' + step + ' > 0) && ' +
                      v[0] + ' > (' + end + ')) || ' +
                     '((' + step + ' < 0) && ' +
                      v[0] + ' < (' + end + '))) { ip = ';
        NewOp();
        flow.push(['for', v[0], ops.length - 1, step]);
      } else if (tok == 'next') {
        Skip('next');
        var f = flow.pop();
        if (f[0] != 'for') {
          Throw('Expected NEXT');
        }
        if (tok != ':' && tok != '<EOL>') {
          var name = tok;
          // TODO: Shouldn't this fail?
          /*
          if (name != f[1]) {
            Throw('Expected ' + f[1]);
          }
          */
          Next();
        }
        curop += f[1] + ' += (' + f[3] + ');\n';
        curop += 'ip = ' + f[2] + ';\n';
        NewOp();
        ops[f[2]] += ops.length + '; }\n';
      } else if (tok == 'circle') {
        Skip('circle');
        Skip('(');
        var x = Expression();
        Skip(',');
        var y = Expression();
        Skip(')');
        Skip(',');
        var r = Expression();
        Skip(',');
        var c = Expression();
        var start = 0;
        var end = Math.PI * 2;
        var aspect = 1;
        var fill = 0;
        if (tok == ',') {
          Skip(',');
          if (tok != ',' && tok != '<EOL>') {
            start = Expression();
          }
        }
        if (tok == ',') {
          Skip(',');
          if (tok != ',' && tok != '<EOL>') {
            end = Expression();
          }
        }
        if (tok == ',') {
          Skip(',');
          if (tok != ',' && tok != '<EOL>') {
            aspect = Expression();
          }
        }
        if (tok == ',') {
          Skip(',');
          if (tok == 'f') {
            fill = 1;
            Next();
          } else {
            Throw('Expected F got ' + tok);
          }
        }
        curop += 'Circle((' +
          [x, y, r, c, start, end, aspect, fill].join('), (') + '));\n';
      } else if (tok == 'pset') {
        Skip('pset');
        Skip('(');
        var x = Expression();
        Skip(',');
        var y = Expression();
        Skip(')');
        Skip(',');
        var extra = [Expression()];
        while (tok == ',') {
          Skip(',');
          if (tok != ',' && tok != '<EOL>') {
            extra.push(Expression());
          }
        }
        curop += 'Pset((' +
          [x, y].concat(extra).join('), (') + '));\n';
      } else if (tok == 'line') {
        Skip('line');
        Skip('(');
        var x1 = Expression();
        Skip(',');
        var y1 = Expression();
        Skip(')');
        Skip('-');
        Skip('(');
        var x2 = Expression();
        Skip(',');
        var y2 = Expression();
        Skip(')');
        Skip(',');
        var c = Expression();
        var fill = 0;
        if (tok == ',') {
          Skip(',');
          if (tok == 'b') {
            fill = 1;
          } else if (tok == 'bf') {
            fill = 2;
          } else {
            Throw('Unexpected ' + tok);
          }
          Next();
        }
        curop += 'Line((' +
          [x1, y1, x2, y2, c, fill].join('), (') + '));\n';
      } else if (tok == 'screen') {
        Skip('screen');
        var ret = 'Screen(';
        var e = Expression();
        ret += '(' + e + ')';
        while (tok == ',') {
          Skip(',');
          if (tok != ',' && tok != '<EOL>') {
            var e = Expression();
            ret += ', (' + e + ')';
          } else {
            ret += ', null';
          }
        }
        ret += ');\n'
        curop += ret;
      } else if (tok == 'sleep') {
        Skip('sleep');
        var e = Expression();
        curop += 'Sleep(' + e + ');\n';
        NewOp();
      } else if (tok == 'locate') {
        Skip('locate');
        var y = Expression();
        Skip(',');
        var x = Expression();
        curop += 'Locate(' + x + ', ' + y + ');\n';
      } else if (tok == 'color') {
        Skip('color');
        var e = Expression();
        curop += 'Color(' + e + ');\n';
      } else if (tok == 'swap') {
        Skip('swap');
        var a = tok;
        Next();
        var va = vars[a];
        if (va == undefined) {
          Throw('Expected variable name');
        }
        Skip(',');
        var b = tok;
        Next();
        var vb = vars[b];
        if (vb == undefined) {
          Throw('Expected variable name');
        }
        curop += 'var t = ' + va[0] + ';\n';
        curop += va[0] + ' = ' + vb[0] + ';\n';
        curop += vb[0] + ' = ' + va[0] + ';\n';
      } else if (tok == 'print') {
        Skip('print');
        if (tok == '<EOL>') {
          curop += 'Print([]);\n';
          return;
        }
        var fmt = null;
        if (tok == 'using') {
          Skip('using');
          fmt = Expression();
          Skip(';');
        }
        var items = [];
        var e = Expression();
        items.push(e);
        while (tok == ';' || tok == ',') {
          items.push('"' + tok + '"');
          Next();
          if (tok == '<EOL>' || tok == ':') {
            break;
          }
          var e = Expression();
          items.push(e);
        }
        if (fmt !== null) {
          curop += 'PrintUsing(' + fmt + ', [' + items.join(', ') + ']);\n';
        } else {
          curop += 'Print([' + items.join(', ') + ']);\n';
        }
      } else if (tok == 'select') {
        Skip('select');
        Skip('case');
        if (tok == 'as') {
          Skip('as');
          Skip('const');
        }
        var e = Expression();
        NewOp();
        flow.push(['select', e, ops.length - 1, [], [], null]);
      } else if (tok == 'case') {
        Skip('case');
        var f = flow.pop();
        if (f[0] != 'select') {
          Throw('Case outside select');
        }
        NewOp();
        f[4].push(ops.length - 1);
        if (tok == 'else') {
          Skip('else');
          f[5] = ops.length;
          flow.push(f);
          return;
        }
        var e = Expression();
        if (tok == 'to') {
          Skip('to');
          var e1 = Expression();
          f[3].push([e, e1, ops.length]);
        } else {
          f[3].push([e, e, ops.length]);
          while (tok == ',') {
            Skip(',');
            var e = Expression();
            f[3].push([e, e, ops.length]);
          }
        }
        flow.push(f);
      } else if (tok == 'getmouse') {
        Skip('getmouse');
        curop += 'Yield();';
        NewOp();
        var v = GetVar(tok);
        curop += v[0] + ' = mouse_x;\n';
        Next();
        Skip(',');
        var v = GetVar(tok);
        curop += v[0] + ' = mouse_y;\n';
        Next();
        if (tok == ',') {
          Skip(',');
          if (tok != ',') {
            var v = GetVar(tok);
            curop += v[0] + ' = mouse_wheel;\n';
            Next();
          }
        }
        if (tok == ',') {
          Skip(',');
          if (tok != ',') {
            var v = GetVar(tok);
            curop += v[0] + ' = mouse_buttons;\n';
            Next();
          }
        }
        if (tok == ',') {
          Skip(',');
          var v = GetVar(tok);
          curop += v[0] + ' = mouse_clip;\n';
          Next();
        }
      } else if (tok == '') {
        return;
      } else {
        var name = tok;
        Next();
        if (tok == ':') {
          Skip(':');
          if (labels[name] !== undefined) {
            Throw('Label ' + name + ' defined twice');
          }
          NewOp();
          curop += '// LABEL ' + name + ':\n';
          labels[name] = ops.length;
          return;
        }
        var vname = IndexVariable(name);
        if (tok == '=' || tok == '+=' || tok == '-=' ||
            tok == '*=' || tok == '/=' || tok == '\\=' ||
            tok == '^=' || tok == '&=') {
          var op = tok;
          Next();
          var e = Expression();
          if (op == '&='){
            op = '+=';
          } else if (op == '\\=') {
            op = '//=';
          } else if (op == '^=') {
            curop += vname + ' = Math.pow(' + vname + ', ' + e + ');\n';
            return;
          }
          curop += vname + ' ' + op + ' (' + e + ');\n';
        } else {
          Throw('Expected "=" or "x=" found "' + tok + '"');
        }
      }
    }

    function Compile() {
      NewOp();
      while (tok != '') {
        for (;;) {
          Statement();
          while (tok == ':') {
            Next();
            Statement();
          }
          if (tok == '') {
            break;
          }
          Skip('<EOL>');
        }
      }
      // Implicit End.
      NewOp();
      curop += 'End();';
      NewOp();

      var total = '';
      total += 'var b = new Uint8Array(' + var_count + ');\n';
      total += 'var i16 = new Int16Array(' + var_count + ');\n';
      total += 'var i = new Int32Array(' + var_count + ');\n';
      total += 'var s = new Float32Array(' + var_count + ');\n';
      total += 'var d = new Float64Array(' + var_count + ');\n';
      total += 'var str = new Array(' + var_count + ');\n';
      total += var_decls;
      total += 'for (var j = 0; j < ops.length; ++j) {\n';
      if (debugging_mode) {
        total += '  console.log("L" + j + ":\\n" + ops[j]);\n';
      }
      total += '  ops[j] = eval("(function() {\\n" + ops[j] + "})\\n");\n';
      total += '}\n';
      if (debugging_mode) {
        console.log(total);
      }
      eval(total);
    }

    var viewport_x, viewport_y;
    var viewport_w, viewport_h;

    function Resize() {
      real_canvas.width  = window.innerWidth;
      real_canvas.height = window.innerHeight;
      var raspect = real_canvas.width / real_canvas.height;
      var aspect = canvas.width / canvas.height;
      if (raspect > aspect) {
        viewport_w = Math.floor(
          canvas.width * real_canvas.height / canvas.height);
        viewport_h = real_canvas.height;
        viewport_x = Math.floor((real_canvas.width - viewport_w) / 2);
        viewport_y = 0;
      } else {
        viewport_w = real_canvas.width;
        viewport_h = Math.floor(
          canvas.height * real_canvas.width / canvas.width);
        viewport_x = 0;
        viewport_y = Math.floor((real_canvas.height - viewport_h) / 2);
      }
    }

    function Render() {
      if (!canvas) {
        return;
      }
      var ctx = real_canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, real_canvas.width, real_canvas.height);
      ctx.drawImage(
        canvas, 0, 0, canvas.width, canvas.height,
        viewport_x, viewport_y, viewport_w, viewport_h);
      requestAnimationFrame(Render);
    }

    function InitEvents() {
      if (!canvas) {
        return;
      }
      Resize();
      window.addEventListener('resize', Resize, false);
      window.addEventListener('keydown', function(e) {
        var k = e.key;
        if (k == 'Escape') { k = String.fromCharCode(27); }
        keys.push(k);
      }, false);
      real_canvas.addEventListener('mousemove', function(e) {
        var rect = canvas.getBoundingClientRect();
        mouse_x = Math.floor(
          (e.clientX - rect.left - viewport_x) * canvas.width / viewport_w);
        mouse_y = Math.floor(
          (e.clientY - rect.top - viewport_y) * canvas.height / viewport_h);
      }, false);
      real_canvas.addEventListener('mousedown', function(e) {
        mouse_buttons = 1;
      }, false);
      real_canvas.addEventListener('mouseup', function(e) {
        mouse_buttons = 0;
      }, false);
      // TODO: Implement Mouse Wheel!
      // TODO: Implement Mouse Clip!
    }

    function Run() {
      for (;;) {
        for (var i = 0; i < 100000; ++i) {
          ops[ip++]();
          if (yielding) {
            yielding = 0;
            if (quitting) {
              return;
            }
            break;
          }
        }
        if (canvas) {
          setTimeout(Run, delay);
          delay = 0;
          break;
        }
      }
    }

    try {
      Compile();
    } catch (e) {
      if (canvas) {
        Locate(1, 1);
        Color(0xffffff);
        Print(e.toString());
      } else {
        console.error(e.toString());
      }
    }
    InitEvents();
    Render();
    Run();
  }

  function SetupCanvas(tag, full_window) {
    if (full_window) {
      var style = 'width:  100%; height: 100%; margin: 0px; border: 0; ' +
        'overflow: hidden; display: block;';
      document.body.style = style;
    }
    var canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    if (full_window) {
      document.body.appendChild(canvas);
    } else {
      tag.insertAdjacentElement('beforebegin', canvas);
    }
    var context = canvas.getContext('2d');
    context.fillStyle = 'black';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'white';
    context.strokeStyle = 'white';
    return canvas;
  }

  function Init() {
    var tags = document.getElementsByTagName('script');
    var count = 0;
    for (var t = 0; t < tags.length; ++t) {
      if (tags[t].type != 'text/basic') {
        continue;
      }
      ++count;
    }
    var full_window = count == 1 && document.body.innerHTML == '';
    for (var t = 0; t < tags.length; ++t) {
      if (tags[t].type != 'text/basic') {
        continue;
      }
      var tag = tags[t];
      var canvas = SetupCanvas(tag, full_window);
      if (tags[t].src) {
        var request = new XMLHttpRequest();
        request.addEventListener("load", function(e) {
          Interpret(request.responseText, canvas);
        }, false);
        request.open("GET", tag.src);
        request.send();
      } else {
        Interpret(tag.text, canvas);
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('load', Init);
  } else {
    exports.Basic = function(code) {
      Interpret(code, null);
    };
  }
})();
