/*
 *  Copyright 2025 Alexey Andreev.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

package org.teavm.javac;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.FieldVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

public class StdlibConverter extends ClassVisitor {
    private static final String PREFIX = "org/teavm/classlib/java/";
    private static final String[] EXCLUDED = {
            "org/teavm/classlib/",
            "org/teavm/jso/impl/",
            "org/teavm/platform",
            "java/nio/charset/impl/",
            "java/util/stream/impl",
            "java/util/stream/intimpl",
            "java/util/stream/longimpl",
            "java/util/stream/doubleimpl",
    };
    boolean visible;
    String className;
    private final Set<String> declaredMethods = new LinkedHashSet<>();
    private final List<ZeroAliasCandidate> zeroAliasCandidates = new ArrayList<>();

    public StdlibConverter(ClassVisitor cv) {
        super(Opcodes.ASM9, cv);
    }

    /**
     * TeaVM's classlib exposes methods that would collide with a real JDK final/native method
     * (Object.getClass(), Throwable.getMessage(), etc.) under a "0"-suffixed name (getClass0,
     * getMessage0, ...) — necessary in TeaVM's own source since it's compiled against a real JDK
     * for testing, but TeaVM's real WASM codegen (runtime-classlib-teavm.bin path) knows to route
     * calls to the real name through to the "0" implementation. This compile-time classlib
     * (javac's view of the SDK, produced by this converter) never had that same routing added, so
     * javac rejects any call to the real name (e.g. "cannot find symbol: method getMessage()").
     * Since this archive is declarations-only (addFile() reads with SKIP_CODE), adding a same-
     * descriptor sibling declaration with the "0" stripped is a safe, no-body alias: it can't
     * change behavior (there's no code here to begin with), it only widens what javac accepts.
     * Guarded by declaredMethods so a real, distinct method already using that name is never
     * shadowed or duplicated.
     */
    private record ZeroAliasCandidate(int access, String name, String desc, String signature, String[] exceptions) {
    }

    @Override
    public void visit(int version, int access, String name, String signature, String superName, String[] interfaces) {
        if ((access & Opcodes.ACC_PRIVATE) != 0) {
            return;
        }
        name = rename(name);
        for (String excluded : EXCLUDED) {
            if (name.startsWith(excluded)) {
                return;
            }
        }

        visible = true;
        className = name;
        declaredMethods.clear();
        zeroAliasCandidates.clear();
        if (superName != null) {
            superName = rename(superName);
        }

        switch (name) {
            case "java/lang/Throwable":
                superName = "java/lang/Object";
                break;
            case "java/lang/RuntimeException":
                superName = "java/lang/Exception";
                break;
        }

        if (interfaces != null) {
            for (int i = 0; i < interfaces.length; ++i) {
                interfaces[i] = rename(interfaces[i]);
            }
        }
        if (signature != null) {
            signature = renameClassSignature(signature);
        }

        if (superName.equals(name)) {
            superName = null;
        }
        super.visit(version, access, name, signature, superName, interfaces);
    }

    @Override
    public FieldVisitor visitField(int access, String name, String desc, String signature, Object value) {
        if ((access & Opcodes.ACC_PUBLIC) == 0 && ((access & Opcodes.ACC_PROTECTED) == 0)) {
            return null;
        }
        desc = renameDesc(desc);
        if (signature != null) {
            signature = renameFieldSignature(signature);
        }
        return new FieldVisitorImpl(super.visitField(access, name, desc, signature, value));
    }

    @Override
    public MethodVisitor visitMethod(int access, String name, String desc, String signature, String[] exceptions) {
        if (className != null && className.equals("java/lang/System")) {
            if (name.equals("out") || name.equals("err") || name.equals("in")) {
                FieldVisitor fv = super.visitField(access, name, renameDesc(Type.getReturnType(desc).getDescriptor()),
                        null, null);
                fv.visitEnd();
                return null;
            }
        }

        if ((access & Opcodes.ACC_PUBLIC) == 0 && ((access & Opcodes.ACC_PROTECTED) == 0)) {
            return null;
        }
        // Bridge methods (covariant-return-type overrides, generic-erasure overrides, etc.) are
        // compiler-generated binary-compatibility artifacts, never written in source and never
        // meant to be visible to source-level overload resolution — javac itself regenerates
        // whatever bridges it needs from the real, non-bridge declaration. Letting one through
        // here adds a second same-name-same-erased-parameter-types method to this declarations-
        // only stub with no source-level override relationship to the real method (that
        // relationship is exactly what ACC_BRIDGE strips), which javac then reports as an
        // ambiguous overload — e.g. any generic class calling StringBuilder.append(T) where T's
        // erasure is Object, since StringBuilder/AbstractStringBuilder's own covariant-return
        // append(Object) override carries a bridge for exactly this reason.
        if ((access & (Opcodes.ACC_BRIDGE | Opcodes.ACC_SYNTHETIC)) != 0) {
            return null;
        }
        desc = renameMethodDesc(desc);
        if (signature != null) {
            signature = renameMethodSignature(signature);
        }

        if (exceptions != null) {
            for (int i = 0; i < exceptions.length; ++i) {
                exceptions[i] = rename(exceptions[i]);
            }
        }

        // rename() collapses TeaVM's own "T"-prefixed classlib root types onto their real-JDK
        // name — in particular org.teavm.classlib.java.lang.TObject onto java.lang.Object, same
        // as any real java.lang.Object parameter/return already renames to. A class can
        // legitimately declare a public method taking the real Object (for real-source-facing
        // API surface, e.g. StringBuilder.append(Object)) *and*, separately, a
        // protected/package-private method taking its own TObject (internal plumbing that real
        // Java source can never reference — TObject isn't a type user code can spell) with an
        // otherwise-identical signature; those two are distinct at TeaVM's own bytecode level but
        // become indistinguishable once both renamed, which real javac can never have seen from a
        // single real class (identical name+erased-descriptor is illegal in one real class file),
        // so it always means one of the colliding declarations is this stub's own artifact, not a
        // real overload — keep only the first one seen.
        String key = name + desc;
        if (!declaredMethods.add(key)) {
            return null;
        }
        if (name.length() > 1 && name.endsWith("0") && !name.startsWith("<")) {
            zeroAliasCandidates.add(new ZeroAliasCandidate(access, name, desc, signature, exceptions));
        }

        return new MethodVisitorImpl(super.visitMethod(access, name, desc, signature, exceptions));
    }

    @Override
    public AnnotationVisitor visitAnnotation(String desc, boolean visible) {
        return super.visitAnnotation(desc, visible);
    }

    // Without this override, ASM's default ClassVisitor.visitInnerClass() passes the inner/outer
    // class names straight through unrenamed - e.g. Map's InnerClasses entry for its nested
    // Entry interface pointed at the original org/teavm/classlib/java/util/TMap$Entry instead of
    // the renamed java/util/Map$Entry every other reference to that type in this stub actually
    // uses. javac resolves qualified-nested-type syntax (Map.Entry) through this attribute, so it
    // went looking for a class file at the stale, unrenamed path - which doesn't exist in this
    // archive - and failed with "cannot find symbol: class Entry". innerName (the simple, already
    // real "Entry") needs no renaming, only the fully-qualified name/outerName do, same as every
    // other class-name reference this converter rewrites (superName, interfaces, exceptions, ...).
    @Override
    public void visitInnerClass(String name, String outerName, String innerName, int access) {
        name = rename(name);
        if (outerName != null) {
            outerName = rename(outerName);
        }
        super.visitInnerClass(name, outerName, innerName, access);
    }

    @Override
    public void visitEnd() {
        for (ZeroAliasCandidate candidate : zeroAliasCandidates) {
            String realName = candidate.name().substring(0, candidate.name().length() - 1);
            String key = realName + candidate.desc();
            if (!declaredMethods.contains(key)) {
                declaredMethods.add(key);
                super.visitMethod(candidate.access(), realName, candidate.desc(), candidate.signature(),
                        candidate.exceptions()).visitEnd();
            }
        }
        super.visitEnd();
    }

    class FieldVisitorImpl extends FieldVisitor {
        FieldVisitorImpl(FieldVisitor fv) {
            super(Opcodes.ASM5, fv);
        }

        @Override
        public AnnotationVisitor visitAnnotation(String desc, boolean visible) {
            if (!visible) {
                return null;
            }
            desc = renameDesc(desc);
            return new AnnotationVisitorImpl(super.visitAnnotation(desc, visible));
        }
    }

    class MethodVisitorImpl extends MethodVisitor {
        MethodVisitorImpl(MethodVisitor mv) {
            super(Opcodes.ASM5, mv);
        }

        @Override
        public AnnotationVisitor visitAnnotation(String desc, boolean visible) {
            if (!visible) {
                return null;
            }
            desc = renameDesc(desc);
            return new AnnotationVisitorImpl(super.visitAnnotation(desc, visible));
        }
    }

    class AnnotationVisitorImpl extends AnnotationVisitor {
        AnnotationVisitorImpl(AnnotationVisitor av) {
            super(Opcodes.ASM5, av);
        }

        @Override
        public AnnotationVisitor visitAnnotation(String name, String desc) {
            if (!visible) {
                return null;
            }
            desc = renameDesc(desc);
            return new AnnotationVisitorImpl(super.visitAnnotation(name, desc));
        }

        @Override
        public void visit(String name, Object value) {
            if (value instanceof Type) {
                value = Type.getType(renameDesc(((Type) value).getDescriptor()));
            }
            super.visit(name, value);
        }
    }

    private String rename(String className) {
        if (className.startsWith(PREFIX)) {
            int slashIndex = className.lastIndexOf('/');
            if (className.charAt(slashIndex + 1) != 'T') {
                return className;
            }

            return "java/" + className.substring(PREFIX.length(), slashIndex) + "/" + className.substring(
                    slashIndex + 2);
        } else if (className.startsWith("org/threeten/bp/")) {
            return "java/time/" + className.substring("org/threeten/bp/".length());
        } else {
            return className;
        }
    }

    private String renameDesc(String desc) {
        DescRename rename = new DescRename(desc);
        rename.renameType();
        return rename.sb.toString();
    }

    private String renameMethodDesc(String desc) {
        DescRename rename = new DescRename(desc);
        assert desc.charAt(0) == '(';
        rename.sb.append('(');
        rename.index++;
        while (desc.charAt(rename.index) != ')') {
            rename.renameType();
        }
        rename.sb.append(')');
        rename.index++;
        rename.renameType();
        return rename.sb.toString();
    }

    class DescRename {
        String desc;
        StringBuilder sb;
        int index;

        DescRename(String desc) {
            this.desc = desc;
            sb = new StringBuilder(desc.length());
        }

        void renameType() {
            char c = desc.charAt(index);
            switch (c) {
                case 'Z':
                case 'B':
                case 'C':
                case 'S':
                case 'I':
                case 'J':
                case 'F':
                case 'D':
                case 'V':
                    sb.append(c);
                    index++;
                    break;
                case '[':
                    sb.append(c);
                    index++;
                    renameType();
                    break;
                case 'L':
                    sb.append(c);
                    int classStart = ++index;
                    index = desc.indexOf(';', index);
                    sb.append(rename(desc.substring(classStart, index)));
                    sb.append(';');
                    index++;
                    break;
            }
        }
    }

    private String renameClassSignature(String signature) {
        SignatureRename rename = new SignatureRename(signature);

        if (rename.current() == '<') {
            renameTypeParameters(rename);
        }

        while (rename.hasMore()) {
            rename.renameClassType();
        }
        return rename.sb.toString();
    }

    private String renameFieldSignature(String signature) {
        SignatureRename rename = new SignatureRename(signature);
        rename.renameFieldType();
        return rename.sb.toString();
    }

    private String renameMethodSignature(String signature) {
        SignatureRename rename = new SignatureRename(signature);

        if (rename.current() == '<') {
            renameTypeParameters(rename);
        }

        assert rename.current() == '(';
        rename.nextChar();
        while (rename.current() != ')') {
            rename.renameType();
        }
        rename.nextChar();
        rename.renameType();

        while (rename.hasMore() && rename.current() == '^') {
            rename.nextChar();
            rename.renameFieldType();
        }
        return rename.sb.toString();
    }

    private void renameTypeParameters(SignatureRename rename) {
        rename.nextChar();
        while (rename.current() != '>') {
            rename.skipIdentifier();
            while (rename.current() == ':') {
                rename.nextChar();
                if (rename.current() != ':' && rename.current() != '>') {
                    rename.renameFieldType();
                }
            }
        }
        rename.nextChar();
    }

    class SignatureRename {
        StringBuilder sb;
        String signature;
        int index;

        SignatureRename(String signature) {
            this.signature = signature;
            sb = new StringBuilder(signature.length());
        }

        char current() {
            return signature.charAt(index);
        }

        boolean hasMore() {
            return index < signature.length();
        }

        void nextChar() {
            sb.append(signature.charAt(index++));
        }

        void skipIdentifier() {
            loop: while (index < signature.length()) {
                switch (current()) {
                    case '.':
                    case ';':
                    case '[':
                    case '/':
                    case '<':
                    case '>':
                    case ':':
                        break loop;
                    default:
                        nextChar();
                        break;
                }
            }
        }

        void renameType() {
            switch (current()) {
                case 'Z':
                case 'B':
                case 'C':
                case 'S':
                case 'I':
                case 'J':
                case 'F':
                case 'D':
                case 'V':
                    nextChar();
                    break;
                default:
                    renameFieldType();
                    break;
            }
        }

        void renameFieldType() {
            switch (current()) {
                case 'L':
                    renameClassType();
                    break;
                case 'T':
                    nextChar();
                    skipIdentifier();
                    assert current() == ';';
                    nextChar();
                    break;
                case '[':
                    nextChar();
                    renameType();
                    break;
            }
        }

        void renameClassType() {
            assert current() == 'L';
            nextChar();

            StringBuilder name = new StringBuilder();
            while (current() != '<' && current() != '.' && current() != ';') {
                name.append(signature.charAt(index++));
            }
            sb.append(rename(name.toString()));

            if (current() == '<') {
                nextChar();
                renameTypeArguments();
            }

            while (current() == '.') {
                nextChar();
                renameSimpleClassType();
            }

            assert current() == ';';
            nextChar();
        }

        void renameSimpleClassType() {
            while (current() != '<' && current() != '.' && current() != ';') {
                nextChar();
            }

            if (current() == '<') {
                nextChar();
                renameTypeArguments();
            }
        }

        void renameTypeArguments() {
            while (current() != '>') {
                if (current() == '*') {
                    nextChar();
                    continue;
                }
                if (current() == '+' || current() == '-') {
                    nextChar();
                }
                renameFieldType();
            }
            nextChar();
        }
    }

    public static void main(String[] args) throws IOException {
        try (var output = new ArchiveBuilder(new FileOutputStream(args[0]))) {
            var packageNames = new LinkedHashSet<String>();
            for (var i = 1; i < args.length; ++i) {
                var file = new File(args[i]);
                if (file.isFile()) {
                    try (var input = new ZipInputStream(new FileInputStream(args[i]))) {
                        while (true) {
                            ZipEntry entry = input.getNextEntry();
                            if (entry == null) {
                                break;
                            }
                            if (entry.isDirectory() || !entry.getName().endsWith(".class")) {
                                continue;
                            }

                            addFile(input, output, packageNames);
                        }
                    }
                } else {
                    try (var stream = Files.walk(file.toPath())) {
                        stream.forEach(path -> {
                            if (Files.isRegularFile(path) && path.getFileName().toString().endsWith(".class")) {
                                try {
                                    addFile(Files.newInputStream(path), output, packageNames);
                                } catch (IOException e) {
                                    throw new UncheckedIOException(e);
                                }
                            }
                        });
                    }
                }
            }
            if (!packageNames.isEmpty()) {
                var writer = new ClassWriter(0);
                writer.visit(Opcodes.V21, Opcodes.ACC_MODULE, "java.base", null, null, null);
                var mv = writer.visitModule("java.base", Opcodes.ACC_OPEN, null);
                for (var packageName : packageNames) {
                    mv.visitExport(packageName, 0, (String[]) null);
                }
                mv.visitEnd();
                output.append("module-info.class", writer.toByteArray());
            }
        }
    }

    private static void addFile(InputStream input, ArchiveBuilder output, Set<String> packageNames) throws IOException {
        ClassReader reader = new ClassReader(input);
        ClassWriter writer = new ClassWriter(0);
        StdlibConverter converter = new StdlibConverter(writer);
        reader.accept(converter, ClassReader.SKIP_CODE | ClassReader.SKIP_FRAMES
                | ClassReader.SKIP_DEBUG);
        if (converter.visible) {
            var outputName = converter.className + ".class";
            output.append(outputName, writer.toByteArray());
        }
        if (converter.className != null) {
            var index = converter.className.lastIndexOf('/');
            if (index > 0) {
                packageNames.add(converter.className.substring(0, index));
            }
        }
    }
}
