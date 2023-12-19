//存储副作用函数的桶
const bucket = new WeakMap();

//原始数据
const data = { foo: 1, bar: 2 }

//用一个全局变量存储当前激活的effect函数
let activeEffect;
/**
 * effect 栈. 主要用来解决 effect函数嵌套的问题
 */
const effectStack = [];

//对原始数据的代理
const obj = new Proxy(data, {
    /**
     * 拦截读取操作
     */
    get(target, key) {

        track(target, key)
        //将当前读取key的副作用函数activeEffect 添加到副作用函数的桶中

        return target[key]
    },
    //拦截设置操作
    set(target, key, newValue) {
        //设置属性
        target[key] = newValue;
        //把副作用函数从桶里面取出来并执行
        trigger(target, key)
    }

})

function track(target, key) {

    if (!activeEffect) return;

    /**
     * 获取到当前taget对象的所有属性的 副作用函数集合
     */
    let depsMap = bucket.get(target)
    if (!depsMap) {
        bucket.set(target, (depsMap = new Map()))
    }

    /**
     * 获取到当前target对象的key属性的 副作用函数集合
     */
    let propertyDeps = depsMap.get(key)

    if (!propertyDeps) {
        depsMap.set(key, (propertyDeps = new Set()))
    }

    /**
     * 添加当前激活的副作用函数 到当前对象的key属性的 副作用函数集合中
     * 
     * set有自动去重功能。 但是需要注意的是effect函数中针对每一个fn函数
     * 每次调用effect都会自动创建一个新的副作用函数包装对象。
     * 
     * 在真实的副作用函数中 多次访问对象A的name属性就会多次被track函数拦截到
     * 就会多次执行这里的add
     */
    propertyDeps.add(activeEffect)

    //每一个副作用函数对象 都持有一个deps属性，保存了他所在的 所有的 副作用函数集合
    //当这个副作用函数废弃的时候，我们要从每一个副作用函数集合中删除 这个 副作用函数
    //todo优化：真实的副作用函数中可能会多次访问对象A的name属性，导致多次被track
    //拦截到，对象A的name属性的 副作用集合只需要 被添加到 deps属性中一次就可以了。
    //而下面没有做这个优化，导致了每次访问对象A的name属性都会导致这个副作用函数
    activeEffect.deps.push(propertyDeps)
}


function trigger(target, key) {
    const depsMap = bucket.get(target)
    if (!depsMap) return;
    const propertyDeps = depsMap.get(key)
    if (!propertyDeps) return;

    const effectsToRun = new Set();
    propertyDeps.forEach(propertyDep => {
        /**
         * 
         * effect函数中创建了副作用的包装函数 effetcFn.
         * effectFn执行，则将activeEffect设置为自己，然后执行真正的副作用函数。
         * 在真实的副作用函数内部读取访问A对象的属性，被拦截 导致effectFn被添加到
         * A对象的属性的副作用函数集合中。  在真实的副作用函数中设置A对象的属性，
         * 这回触发A对象属性的副作用函数集合中每一个副作用函数执行。 也就是导致
         * effectFn执行，此时就会出现死循环问题。
         * 这里主要是为了避免死循环。 如果是在真实的副作用函数中对属性key进
         * 行了设置，那么就不要再次触发 真实副作用函数的包装副作用函数effectFn的
         * 执行了。 
         * 
         */
        if (activeEffect !== propertyDep)
            effectsToRun.add(propertyDep)
    })

    effectsToRun.forEach(effectFn => {
        if (effectFn.options.scheduler) {
            /**
             * 使用scheduler 函数来 执行自己(副作用函数)。
             * 
             * 正常情况下，对象A的name属性发生了变化会导致A对象的name属性的副作用函数集合中的每一个副作用函数执行。 但是有的时候我们不仅仅想让副作用函数
             * 执行，还想掺杂其他的逻辑，实现 比如延迟执行，或者执行前准备，执行后处理，等等。
             * 还有一种场景： 比如在真实的副作用函数中我们对A对象的name属性做了多次修改，每次修改都会被拦截到然后执行这里的trigger方法，trigger中又会触发
             * 每个副作用函数的执行。 实际上，副作用函数中的多次对name属性的修改，我们只需要触发一次副作用函数的执行就可以了。 
             * 
             * 所有这些逻辑都是 围绕如何调度 副作用函数的执行。  scheduler函数就是用来实现这些逻辑的。
             * 
             * 
             */
            effectFn.options.scheduler(effectFn);
        } else {
            effect();
        }
    })

}

function effect(fn, options = {}) {

    /**
     * 
     *  针对fn函数对象 每次都会创建一个新的副作用函数包装对象
     * 
     */
    const effectFn = () => {

        /**
         * 执行真实的副作用函数之前 先把 一些对象的某些属性的副作用函数集合 ，
         * 这些副作用函数集合中持有了当前的包装副作用函数的引用， 将当前的副作用
         * 包装函数从这些 副作用函数集合中移除。
         * 
         * 因为真实的副作用函数在第一次执行的时候可能读取到了 A对象的name属性，
         * 导致effectFn被添加到了A对象的name属性的副作用函数集合中。 但是在
         * 第二次执行的时候就没有读取A对象的name属性，而是去读了B对象的address
         * 属性，那么effectFn这个副作用包装函数就不应该在A对象的name属性的副作用
         * 集合中，而仅仅是在B对象的address属性的副作用函数集合中。
         * 
         * 因此每次 真实的副作用 函数执行之前 先清除 画板。 重新统计 这个真实
         * 的副作用函数中 到底访问读取到了哪些对象的哪些属性
         * 
         */
        cleanup(effectFn);

        //当该副作用函数执行的时候，将全局激活副作用函数设置为自己
        activeEffect = effectFn;

        //在调用副作用函数之前将当前副作用函数压栈

        effectStack.push(effectFn)

        //执行副作用函数
        const res = fn();

        //在当前副作用哈桑农户执行完毕之后，加ing当前副作用函数弹出栈，并还原activeEffect为之前的值
        effectStack.pop();
        activeEffect = effectStack[effectStack.length - 1]

        return res;
    }

    /**
     * 每一个副作用函数 都会有一个deps属性，这个deps属性保存了 所有
     * 这个副作用函数 所在的 副作用函数集合。
     * 副作用函数A 里面 读取了 A对象的name属性，和B对象的address属性，那么这个副
     * 作用函数会同时被放入到 A对象的name属性的副作用函数集合 和B的address属性的
     * 副作用函数集合中。
     * 
     * 当副作用函数 废弃的时候，需要从每一个副作用函数集合中移除自身。
     */
    effectFn.deps = [];

    effectFn.options = options;


    /**
     * 返回副作用 函数。
     * 副作用函数一旦被执行，就会1.将activeEffect设置为自己，
     * 2.读取对象的属性 被拦截到track函数中，track函数会将当前副作用函数添加到
     * 对象的属性的副作用函数集合中。
     */
    return effectFn;

}


function cleanup(effectFn) {
    for (let i = 0; i < effectFn.deps.length; i++) {
        const propertyDeps = effectFn.deps[i];
        propertyDeps.delete(effectFn);
    }
    effectFn.deps.length = 0;
}


//-------------------------
/**
 * 这个函数主要用来实现 对Value对象的所有属性都进行一次读操作。从而触发track函数
 * 
 * 但是需要注意的是 并不是说 对value进行了读就会被track。
 * 
 * traverse作为副作用函数，他必须要交给effect函数来执行，才能被track。
 * effect函数内部会真实的副作用函数创建 副作用函数包装对象。
 * 
 * 在副作用函数包装对象中会 将activeEffect设置为自己，然后执行真实的副作用函数。
 * 这个时候执行真实的副作用函数，就会触发track函数。
 * 
 * 仅仅是普通的调用traverse函数并不会触发track函数。 track函数中有判断
 * activeEffect是否存在，如果不存在，就不会触发track函数。
 * 
 * @param {*} value 
 * @param {*} seen 
 * @returns 
 */
function traverse(value, seen = new Set()) {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;

    seen.add(value);
    /**
     * 对响应式对象value的每一个属性 都进行一次读操作，这样就会触发track函数
     * 问题：对于Proxy代理对象 forin能 遍历出target对象的属性吗？
     * 
     */
    for (const k in value) {
        traverse(value[k], seen)
    }
    return value;
}

function watch(source, cb, options = {}) {
    /**
     * watch监听的可以是一个响应式对象， 也可以是一个getter函数。
     * 
     * Vue中的watch  如果是监听一个响应式对象，那么当这个响应式对象的属性发生变化的时候，会触发watch的回调函数。
     * 如果监听的是一个getter函数，那么当这个getter函数中访问的响应式对象的属性发生变化的时候，并不一定会触发watch的回调函数，只有当getter函数返回的值不同
     * 的时候 才会触发watch的回调函数。
     * 
     *Vue中：点击按钮回随机change name， 每次change name都会导致 getter函数被执行。只有当get函数返回的值发生变化时，才会触发监听函数。所以getter函数中访问
     *到的相应式对象的属性每次发生变化都会导致getter的执行。只是可能不会导致监听
     *函数的执行。
     */

    let getter;
    if (typeof source === 'function') {
        getter = source;
    } else {
        getter = () => traverse(source);
    }

    let oldValue, newValue;

    /**
     * 
     * 在之前的代码中 effect函数用来创建一个 真实副作用函数的包装副作用函数。
     * 
     * 当执行这个包装副作用函数的时候 会导致真实副作用函数的执行，在真实副作用函数
     * 中访问到A对象的name属性的时候会触发track函数，track函数会将当前的包装副作用
     * 放置到A对象的name属性的副作用函数集合中。
     * 
     * 当A对象的name属性发生变化的时候，会执行A对象的name属性的副作用函数集合中的
     * 每一个副作用包装函数。但是关于这个怎么执行的问题有多种方案，
     * 你可以直接执行：也就是遍历到后直接执行。 也可以是延迟执行比如使用setTimeout
     * 还可以交给一个调度器函数去执行  也就是  effectFn.options.scheduler(effectFn);
     * 
     * 那么交给调度器函数来执行有什么好处呢？
     * 调度器中可以 做 执行前准备，执行后处理。 比如真实的副作用函数有返回值，
     * 我们想每次 执行完真实的副作用函数之后，都将返回值打印出来，而不仅仅是只
     * 执行副作用函数，那么我们就可以在调度器中做这个事情。 这本质上类似于
     * 执行副作用函数得到结果之后 调用另一个函数来处理这个结果，比如watch监听。
     * 
     * 
     * 因此在下面的代码中我们将 scheduler的逻辑抽成一个函数
     * 
     */
    //定义上一次watch监听器的失效函数
    let previousWatchInvalidate;
    function onInvalidate(fn) {
        previousWatchInvalidate = fn;
    }
    const job = () => {
        /**
         * 执行副作用函数，获取到副作用函数的返回值
         */
        newValue = effectFn;
        /**
         * 处理副作用函数的返回值。
         * 
         * 调用上一次 watch监听器对象设置的 失效处理函数。告知上一次监听器
         * 对象，上一次的watch通知失效了
         */
        if (previousWatchInvalidate) {
            previousWatchInvalidate();
        }

        /**
         * 调用用户的监听函数，告知副作用的执行结果.
         * 并提供函数onInvalidate，让用户可以在这个函数中修改previousWatchInvalidate等于自己的失效处理函数
         * 等到下一次副作用函数执行的时候，就会先执行上一次的失效处理函数，告知上一次的watch监听器，上一次的watch通知失效了。
         * 
         */
        cb(newValue, oldValue, onInvalidate)
        oldValue = newValue;
    }
    const effectFn = effect(() => getter(), {
        lazy: true,
        scheduler: () => {
            if (options.flush === 'post') {
                const p = Promise.resolve();
                p.then(job);
            } else {
                job();
            }
        }

    })
    /**
     * job函数中也是执行 副作用函数effectFn. 为什么下面的立即触发 就会
     * 调用job()，而不是立即触发就会调用effetcFn()呢？
     * 主要是job触发 多了针对 effectFn副作用函数返回结果值的处理。
     * 
     * 在立即调用的语义中是指立即调用用户的watch监听函数，job函数比较适合。
     * 
     * 非立即调用的语义中只需要简单执行一次副作用函数就可以了。
     * 
     */
    if (options.immediate) {
        job();
    } else {
        oldValue = effectFn();
    }

}


//====test watch
let count = 0;
function fetch() {
    count++;
    const res = count === 1 ? "A" : 'B';
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve(res)
        }, count === 1 ? 1000 : 100)
    })
}
let finallyData;

watch(() => obj.foo, async (newValue, oldValue, onInvalidate) => {
    let valid = false;
    onInvalidate(() => {
        valid = true;
    })
    const res = await fetch();

    if (!valid) return;
    finallyData = res;
    console.log(finallyData)
})

/**
 * 首先先对foo属性进行一次修改，这回触发watch监听器的执行，在监听器中执行了
 * fetch函数，setTimeout 1000毫秒后 promise执行完成。
 * 
 * 然后下面又 setTimeout 200毫秒后对foo属性进行一次修改，这又会
 * 触发watch监听器的执行，且fetch中的promise 100毫秒后执行完成。
 * 
 * 也就是实现了第二次对foo属性的修改 监听器会 先执行完 fetch后继续执行。
 * 而第一次对监听器的修改，watch监听器 会晚些时候菜执行完fetch，此时会发现
 * 第二次的监听器已经将 第一次监听器的 valid改为false了，因此第一次监听
 * 器在返回fetch之后就不会继续往下执行 fianllyData = res; console.log(finallyData)
 */

obj.foo++;

setTimeout(() => {
    obj.foo++;
}, 200)






//=====================实现一个调度器，调度器保证每一个副作用函数只会执行一次=====================

function abc() {
    const jobQueue = new Set();
    const p = Promise.resolve();
    let isFlushing = false;
    function flushJob() {
        if (isFlushing) return;
        isFlushing = true;
        p.then(() => {
            jobQueue.forEach(job => job());
        }).finally(() => {
            isFlushing = false;
        })
    }
    effect(() => {
        console.log(obj.foo)
    }, {
        scheduler(fn) {
            jobQueue.add(fn);
            flushJob();
        }
    })
}

//====测试 p.then是否针对能保证只调用一次
function testPThen() {
    const jobQueue = new Set()
    let isFlushing = false
    function flushJob() {
        /**
         * 在外部  arrayFuncs.forEach 中会多次调用flushJob函数。
         * 
         *flushJob函数中虽然会 先将 isFlushing设置为true,然后又将
         *isFlushing改为false， 但是这并不意味着 flushJob函数执行
         *完之后isFlushing就是false。
         * 换句话说， 当第一次执行 isFlushing的时候会将他改为true，
         * 遍历到第二个元素再次执行isFlushing的时候isFlushing 是false吗？ 
         * 还是会保持之前的true呢？
         * 
         * 这个涉及到 js的事件循环机制， 事件循环机制中有一个微任务队列，
         * 对于一处于pending状态的Promise对象p，内部状态的resolve，
         * 会让p.then(fn)中的fn加入微任务队列  
         *  对于一处于fulfilled状态的Promise对象p，p.then(fn)会立即
         * 让fn加入微任务队列
         * 
         * 在这里的p是一个处于fulfilled状态的Promise对象，所以会立即让then
         * 中指定的函数加入微任务队列。 但是这个微任务队列中的函数什么时候执行
         * 是不确定的，他只是加入到了微任务队列。
         * 当前线程的主要任务是执行当前的代码，当前的代码就是  arrayFuncs.forEach 
         * 这个遍历操作。遍历操作中将then指定的函数添加到了微任务，并不意味着
         * 当前会立即执行这个微任务。
         * 
         * 所以当前线程的当前代码执行完毕之后，才会执行微任务队列中的函数。
         * 所以整个遍历过程中 isFlushing都是true， 这就意味着 在遍历过程中
         * 我们只 执行了一次p.then() 从而保证了 对jobQueue对象只做一次foreach
         * 遍历。 而不是 在外部  arrayFuncs.forEach 中会多次调用flushJob函数，
         * 然后又多次对jobQueue进行遍历。
         * 
         * 
         * 值得注意的是 我们对flushJob 调用10次，每次都是使用了同
         * 一个Promise对象提交微任务。
         * 
         */
        if (isFlushing) return
        isFlushing = true
        p.then(() => {
            jobQueue.forEach(job => job())
        }).finally(() => {
            isFlushing = false
        })
    }
    const p = Promise.resolve()
    const arrayFuncs = [];
    for (let i = 0; i < 10; i++) {
        const index = i;
        const funcTemp = () => {
            console.log("我是第" + index + "个函数")
        }
        arrayFuncs.push(funcTemp);
    }

    arrayFuncs.forEach(func => {
        jobQueue.add(func)
        flushJob()
    })
}
//--------执行结果
// D:\tempFiles>node a.js
// 我是第0个函数
// 我是第1个函数
// 我是第2个函数
// 我是第3个函数
// 我是第4个函数
// 我是第5个函数
// 我是第6个函数
// 我是第7个函数
// 我是第8个函数
// 我是第9个函数


//====== 如果注释掉 flushJob函数中的 if (isFlushing) return
//那么就意味着每次执行flushJob都会 执行p.then() ，每次p.then都会向
//微任务队列中提交一个微任务。因此 arrayFuncs.forEach 中会多次调用flushJob函数，
//当前js线程执行完arrayFuncs.forEach  没有其他代码可以执行，因此会去执行微任务
//所以10个微任务，每个微任务都会对 jobQueue(10个数据)进行一次遍历，
//所以会打印10*10=100次

