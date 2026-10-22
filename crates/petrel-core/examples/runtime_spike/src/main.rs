mod scripts;

#[cfg(feature = "quickjs")]
use std::time::Duration;
use std::time::Instant;

fn report(label: &str, t: Instant, result: &str) {
    println!("{label:<16} {:>8.2} ms  {}", t.elapsed().as_secs_f64() * 1000.0, result);
}

#[cfg(feature = "quickjs")]
fn main() {
    use rquickjs::{Context, Function, Object, Promise, Runtime};
    let t = Instant::now();
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    report("init", t, "runtime + context");

    let eval = |src: &str| -> String {
        ctx.with(|ctx| match ctx.eval::<rquickjs::Value, _>(src) {
            Ok(v) => format!(
                "{:?}",
                v.as_string().map(|s| s.to_string().unwrap()).unwrap_or_else(|| format!("{v:?}"))
            ),
            Err(e) => format!(
                "error: {}",
                ctx.catch().as_exception().map(|x| x.message().unwrap_or_default()).unwrap_or(e.to_string())
            ),
        })
    };
    let t = Instant::now();
    let r = eval(scripts::STRING_WORK);
    report("string work", t, &r);
    let t = Instant::now();
    let r = eval(scripts::CLASSES);
    report("classes", t, &r);

    // Async over a host function: the script gets a promise; we run the job queue to completion.
    let t = Instant::now();
    let r = ctx.with(|ctx| {
        let host = Object::new(ctx.clone()).unwrap();
        let calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let c = calls.clone();
        host.set(
            "clipboard",
            Function::new(ctx.clone(), move || {
                c.set(c.get() + 1);
                format!("clip{}", c.get())
            })
            .unwrap(),
        )
        .unwrap();
        ctx.globals().set("host", host).unwrap();
        let p: Promise = ctx.eval(scripts::ASYNC_HOST).unwrap();
        while ctx.execute_pending_job() {}
        p.result::<String>().map(|r| r.unwrap_or_default()).unwrap_or_else(|| "pending".into())
    });
    report("async host", t, &r);

    // Interrupt: the handler is polled by the engine; we stop after 100 ms.
    let deadline = Instant::now() + Duration::from_millis(100);
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let t = Instant::now();
    let r = eval(scripts::INFINITE_LOOP);
    report("infinite loop", t, &r);
    rt.set_interrupt_handler(None);

    // Memory limit: 32 MB; the script wants 64.
    rt.set_memory_limit(32 * 1024 * 1024);
    let t = Instant::now();
    let r = eval(scripts::BIG_ALLOC);
    report("64 MB alloc", t, &r);
    println!("binary: {} kB", std::fs::metadata(std::env::current_exe().unwrap()).unwrap().len() / 1024);
}

#[cfg(feature = "boa")]
fn main() {
    use boa_engine::{
        js_string, native_function::NativeFunction, object::ObjectInitializer, Context, JsValue, Source,
    };
    let t = Instant::now();
    let mut ctx = Context::default();
    report("init", t, "context");

    fn eval(ctx: &mut Context, src: &str) -> String {
        match ctx.eval(Source::from_bytes(src)) {
            Ok(v) => v.to_string(ctx).map(|s| s.to_std_string_escaped()).unwrap_or_else(|_| format!("{v:?}")),
            Err(e) => format!("error: {e}"),
        }
    }
    let t = Instant::now();
    let r = eval(&mut ctx, scripts::STRING_WORK);
    report("string work", t, &r);
    let t = Instant::now();
    let r = eval(&mut ctx, scripts::CLASSES);
    report("classes", t, &r);

    let t = Instant::now();
    let host = ObjectInitializer::new(&mut ctx)
        .function(
            NativeFunction::from_fn_ptr(|_, _, _| Ok(JsValue::from(js_string!("clip")))),
            js_string!("clipboard"),
            0,
        )
        .build();
    ctx.register_global_property(js_string!("host"), host, boa_engine::property::Attribute::all()).unwrap();
    let v = ctx.eval(Source::from_bytes(scripts::ASYNC_HOST)).unwrap();
    ctx.run_jobs();
    let r = v
        .as_promise()
        .and_then(|p| match p.state() {
            boa_engine::builtins::promise::PromiseState::Fulfilled(v) => {
                Some(v.to_string(&mut ctx).unwrap().to_std_string_escaped())
            }
            _ => None,
        })
        .unwrap_or_else(|| "pending".into());
    report("async host", t, &r);

    // Boa has no interrupt handler; the documented way is a runtime limit on loop iterations.
    ctx.runtime_limits_mut().set_loop_iteration_limit(10_000_000);
    let t = Instant::now();
    let r = eval(&mut ctx, scripts::INFINITE_LOOP);
    report("loop limit", t, &r);

    // Boa has no memory limit API; the allocation simply happens.
    let t = Instant::now();
    let r = eval(&mut ctx, scripts::BIG_ALLOC);
    report("64 MB alloc", t, &format!("{r} (no limit available)"));
    println!("binary: {} kB", std::fs::metadata(std::env::current_exe().unwrap()).unwrap().len() / 1024);
}

#[cfg(not(any(feature = "quickjs", feature = "boa")))]
fn main() {
    eprintln!("build with --features quickjs or --features boa");
}
