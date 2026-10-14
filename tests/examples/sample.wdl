version 1.0

workflow HelloWorld {
  input {
    String name = "World"
    Int repeat = 3
  }

  scatter (i in range(repeat)) {
    call sayHello {
      input:
        greeting = name,
        index = i
    }
  }

  call collectResults {
    input:
      messages = sayHello.message
  }

  output {
    Array[String] greetings = sayHello.message
    String summary = collectResults.result
  }
}

task sayHello {
  input {
    String greeting
    Int index
  }

  command <<<
    echo "Hello, ~{greeting}! (iteration ~{index})"
  >>>

  output {
    String message = read_string(stdout())
  }

  runtime {
    docker: "ubuntu:20.04"
    cpu: 1
    memory: "1 GB"
  }
}

task collectResults {
  input {
    Array[String] messages
  }

  command <<<
    echo "~{length(messages)} greetings collected."
  >>>

  output {
    String result = read_string(stdout())
  }

  runtime {
    docker: "ubuntu:20.04"
    cpu: 1
    memory: "1 GB"
  }
}
